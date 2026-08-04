import { createHmac, timingSafeEqual } from "node:crypto";
import {
	createApplication,
	createProject,
	deleteProject,
	findApplicationById,
	getProductDeploymentDetail,
	getProductNavigationContext,
	getProductProjectOverview,
	getProductWorkspaceOverview,
	IS_CLOUD,
	moveAlias,
	removeDirectoryCode,
	toProductSlug,
	updateApplication,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { projectSources } from "@dokploy/server/db/schema";
import {
	buildRepositoryEvidenceFromGithub,
	DETECTOR_REGISTRY_VERSION,
	detectFramework,
} from "@dokploy/server/frameworks";
import {
	addNewEnvironment,
	addNewProject,
	addNewService,
	checkPermission,
	checkProjectAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { Octokit } from "octokit";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import type { DeploymentJob } from "@/server/queues/queue-types";
import {
	cleanQueuesByApplication,
	myQueue,
} from "@/server/queues/queueSetup";
import { deploy } from "@/server/utils/deploy";

const slugField = z
	.string()
	.min(1)
	.max(63)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const productAccess = async (ctx: {
	user: { id: string };
	session: { activeOrganizationId: string };
}) => {
	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	const privileged = member.role === "owner" || member.role === "admin";
	return {
		userId: ctx.user.id,
		projectIds: privileged ? null : member.accessedProjects,
		environmentIds: privileged ? null : member.accessedEnvironments,
		serviceIds: privileged ? null : member.accessedServices,
	};
};

const parseRepository = (value: string) => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Enter a valid HTTPS repository URL",
		});
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Repository imports require a credential-free HTTPS URL",
		});
	}
	url.search = "";
	url.hash = "";
	const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
	const repositoryName = (parts.at(-1) || "repository").replace(/\.git$/i, "");
	return {
		url: url.toString(),
		owner: parts.length > 1 ? parts.at(-2) || null : null,
		name: repositoryName,
	};
};

const importCleanupKey = () =>
	process.env.DEPLOYTIDE_SECRET_DIGEST_KEY || process.env.BETTER_AUTH_SECRET || "";

const signImportCleanup = (
	projectId: string,
	organizationId: string,
	userId: string,
	expiresAt: number,
) => {
	const key = importCleanupKey();
	if (!key) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Import cleanup signing is not configured",
		});
	}
	return createHmac("sha256", key)
		.update(`${projectId}:${organizationId}:${userId}:${expiresAt}`)
		.digest("base64url");
};

const verifyImportCleanup = (
	proof: string,
	projectId: string,
	organizationId: string,
	userId: string,
	expiresAt: number,
) => {
	if (expiresAt < Date.now()) return false;
	const expected = signImportCleanup(
		projectId,
		organizationId,
		userId,
		expiresAt,
	);
	const actualBuffer = Buffer.from(proof);
	const expectedBuffer = Buffer.from(expected);
	return (
		actualBuffer.length === expectedBuffer.length &&
		timingSafeEqual(actualBuffer, expectedBuffer)
	);
};

const rollbackFailedImport = async (
	projectId: string,
	organizationId: string,
	cause: unknown,
): Promise<never> => {
	try {
		await deleteProject(projectId, organizationId);
	} catch (cleanupError) {
		throw new AggregateError(
			[cause, cleanupError],
			"Project import failed and its partial records could not be retired",
		);
	}
	throw cause;
};

/**
 * Best-effort framework detection for a repository-mode import. Only public
 * github.com repositories can be scanned without a connected GitHub App
 * installation; anything else (private repos, non-GitHub hosts, network or
 * rate-limit failures) degrades to a null result and the caller falls back
 * to the application's existing default buildType. This never throws.
 */
const detectRepositoryFramework = async (
	repository: { url: string; owner: string | null; name: string },
	branch: string,
) => {
	try {
		const url = new URL(repository.url);
		if (url.hostname !== "github.com" || !repository.owner) return null;
		const octokit = new Octokit();
		const evidence = await buildRepositoryEvidenceFromGithub({
			octokit,
			owner: repository.owner,
			repo: repository.name,
			ref: branch,
			timeoutMs: 8_000,
		});
		if (evidence.files.size === 0) return null;
		return detectFramework(evidence);
	} catch {
		return null;
	}
};

export const productRouter = createTRPCRouter({
	context: protectedProcedure.query(async ({ ctx }) => {
		const access = await productAccess(ctx);
		return getProductNavigationContext(
			ctx.session.activeOrganizationId,
			access,
		);
	}),

	workspaceOverview: protectedProcedure.query(async ({ ctx }) =>
		getProductWorkspaceOverview(
			ctx.session.activeOrganizationId,
			await productAccess(ctx),
		),
	),

	projectOverview: protectedProcedure
		.input(z.object({ projectSlug: slugField }))
		.query(async ({ ctx, input }) =>
			getProductProjectOverview(
				ctx.session.activeOrganizationId,
				input.projectSlug,
				await productAccess(ctx),
			),
		),

	deploymentDetail: protectedProcedure
		.input(
			z.object({
				projectSlug: slugField,
				deploymentId: z.string().min(1),
			}),
		)
		.query(async ({ ctx, input }) =>
			getProductDeploymentDetail(
				ctx.session.activeOrganizationId,
				input.projectSlug,
				input.deploymentId,
				await productAccess(ctx),
			),
		),

	importProject: protectedProcedure
		.input(
			z
				.object({
					mode: z.enum(["repository", "upload"]),
					name: z.string().trim().min(1).max(80),
					description: z.string().trim().max(280).optional(),
					repositoryUrl: z.string().trim().optional(),
					branch: z.string().trim().min(1).max(255).default("main"),
					rootDirectory: z.string().trim().max(512).default("/"),
				})
				.superRefine((input, context) => {
					if (input.mode === "repository" && !input.repositoryUrl) {
						context.addIssue({
							code: "custom",
							path: ["repositoryUrl"],
							message: "Repository URL is required",
						});
					}
				}),
		)
		.mutation(async ({ ctx, input }) => {
			await checkProjectAccess(ctx, "create");
			await checkPermission(ctx, {
				service: ["create"],
				deployment: ["create"],
			});
			const repository =
				input.mode === "repository"
					? parseRepository(input.repositoryUrl || "")
					: null;
			let projectId: string | null = null;
			try {
				const created = await createProject(
					{
						name: input.name,
						description: input.description,
					},
					ctx.session.activeOrganizationId,
				);
				projectId = created.project.projectId;
				await addNewProject(ctx, created.project.projectId);
				await addNewEnvironment(ctx, created.environment.environmentId);

				const appName = `${toProductSlug(input.name)}-${nanoid(5).toLowerCase()}`;
				const application = await createApplication({
					name: input.name,
					appName,
					description: input.description,
					environmentId: created.environment.environmentId,
				});
				await addNewService(ctx, application.applicationId);

				const detection = repository
					? await detectRepositoryFramework(repository, input.branch)
					: null;

				await updateApplication(application.applicationId, {
					sourceType: input.mode === "repository" ? "git" : "drop",
					customGitUrl: repository?.url ?? null,
					customGitBranch: repository ? input.branch : null,
					customGitBuildPath: repository ? input.rootDirectory : null,
					dropBuildPath: input.mode === "upload" ? input.rootDirectory : null,
					applicationStatus: "idle",
					...(detection?.buildType ? { buildType: detection.buildType } : {}),
					...(detection?.startCommand ? { command: detection.startCommand } : {}),
					...(detection?.buildType === "static" && detection.outputDirectory
						? { publishDirectory: detection.outputDirectory }
						: {}),
				});

				await db.insert(projectSources).values({
					organizationId: ctx.session.activeOrganizationId,
					projectId: created.project.projectId,
					provider: input.mode === "repository" ? "git" : "upload",
					repositoryOwner: repository?.owner,
					repositoryName: repository?.name,
					repositoryId: repository?.url,
					defaultBranch: repository ? input.branch : "main",
					rootDirectory: input.rootDirectory,
					detectorVersion: detection ? DETECTOR_REGISTRY_VERSION : null,
					detectorResult: detection ? { ...detection } : null,
					autoDeployPolicy: {
						enabled: input.mode === "repository",
						productionBranch: repository ? input.branch : "main",
						previewBranches: input.mode === "repository",
					},
				});
				await audit(ctx, {
					action: "create",
					resourceType: "project",
					resourceId: created.project.projectId,
					resourceName: created.project.name,
					metadata: { importMode: input.mode },
				});
				let cleanupExpiresAt: number | null = null;
				let cleanupProof: string | null = null;
				if (input.mode === "repository") {
					const importedApplication = await findApplicationById(
						application.applicationId,
					);
					await audit(ctx, {
						action: "deploy",
						resourceType: "application",
						resourceId: importedApplication.applicationId,
						resourceName: importedApplication.appName,
					});
					const jobData: DeploymentJob = {
						applicationId: importedApplication.applicationId,
						titleLog: "Initial repository deployment",
						descriptionLog: `Imported ${repository?.url ?? "repository"}`,
						type: "deploy",
						applicationType: "application",
						server: Boolean(importedApplication.serverId),
						serverId: importedApplication.serverId ?? undefined,
					};
					if (IS_CLOUD && importedApplication.serverId) {
						await deploy(jobData);
					} else {
						await myQueue.add("deployments", jobData, {
							removeOnComplete: true,
							removeOnFail: true,
						});
					}
				} else {
					cleanupExpiresAt = Date.now() + 30 * 60 * 1000;
					cleanupProof = signImportCleanup(
						created.project.projectId,
						ctx.session.activeOrganizationId,
						ctx.user.id,
						cleanupExpiresAt,
					);
				}
				return {
					project: created.project,
					environmentId: created.environment.environmentId,
					applicationId: application.applicationId,
					mode: input.mode,
					cleanupExpiresAt,
					cleanupProof,
				};
			} catch (error) {
				if (projectId) {
					return rollbackFailedImport(
						projectId,
						ctx.session.activeOrganizationId,
						error,
					);
				}
				throw error;
			}
		}),

	cleanupFailedImport: protectedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				expiresAt: z.number().int().positive(),
				proof: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await checkProjectAccess(ctx, "create");
			if (
				!verifyImportCleanup(
					input.proof,
					input.projectId,
					ctx.session.activeOrganizationId,
					ctx.user.id,
					input.expiresAt,
				)
			) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Import cleanup authorization is invalid or expired",
				});
			}
			const project = await db.query.projects.findFirst({
				where: (table, { and, eq, isNull }) =>
					and(
						eq(table.projectId, input.projectId),
						eq(table.organizationId, ctx.session.activeOrganizationId),
						isNull(table.deletedAt),
					),
				columns: { projectId: true },
			});
			if (!project) return true;
			const importedApplications = await db.query.applications.findMany({
				where: (table, { and, eq, isNull }) =>
					and(
						eq(table.projectId, project.projectId),
						eq(table.organizationId, ctx.session.activeOrganizationId),
						isNull(table.deletedAt),
					),
				columns: {
					applicationId: true,
					appName: true,
					serverId: true,
				},
			});
			for (const application of importedApplications) {
				await cleanQueuesByApplication(application.applicationId);
				await removeDirectoryCode(application.appName, application.serverId);
			}
			await deleteProject(
				project.projectId,
				ctx.session.activeOrganizationId,
			);
			return true;
		}),

	rollbackProduction: protectedProcedure
		.input(z.object({ projectSlug: slugField }))
		.mutation(async ({ ctx, input }) => {
			await checkPermission(ctx, { deployment: ["create"] });
			const access = await productAccess(ctx);
			const overview = await getProductProjectOverview(
				ctx.session.activeOrganizationId,
				input.projectSlug,
				access,
			);
			if (
				access.projectIds !== null &&
				!access.projectIds.includes(overview.project.projectId)
			) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
			}
			const targetReleaseId = overview.production.rollbackReleaseId;
			const productionAlias = overview.production.alias;
			if (!targetReleaseId || !productionAlias) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "No retained production release is available for rollback",
				});
			}
			const result = await moveAlias({
				organizationId: ctx.session.activeOrganizationId,
				aliasId: productionAlias.aliasId,
				expectedVersion: productionAlias.version,
				nextReleaseId: targetReleaseId,
				actorId: ctx.user.id,
				reason: "Project overview production rollback",
				idempotencyKey: `project-rollback:${overview.project.projectId}:${productionAlias.version}`,
			});
			await audit(ctx, {
				action: "restore",
				resourceType: "deployment",
				resourceId: targetReleaseId,
				resourceName: overview.project.name,
			});
			return result;
		}),
});
