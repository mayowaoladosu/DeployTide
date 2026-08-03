import { db } from "@dokploy/server/db";
import {
	aliases,
	aliasHistory,
	applications,
	artifacts,
	auditLog,
	builds,
	compose,
	deployments,
	domains,
	environments,
	environmentVariables,
	libsql,
	mariadb,
	mongo,
	mysql,
	organization,
	postgres,
	previewDeployments,
	projectSources,
	projects,
	redis,
	releases,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";

export interface ProductAccess {
	projectIds: string[] | null;
	environmentIds: string[] | null;
	serviceIds: string[] | null;
	userId: string;
}

const hiddenActivityTypes = new Set([
	"certificate",
	"cluster",
	"docker",
	"network",
	"registry",
	"server",
	"sshKey",
	"swarm",
]);

const normalizeDeploymentStatus = (status?: string | null) => {
	if (status === "done") return "ready";
	if (status === "error") return "failed";
	if (status === "running") return "deploying";
	return status ?? "queued";
};

const projectScope = (access: ProductAccess) =>
	access.projectIds === null
		? undefined
		: access.projectIds.length > 0
			? inArray(projects.projectId, access.projectIds)
			: sql`false`;

const idScope = <TColumn>(column: TColumn, ids: string[] | null) =>
	ids === null
		? undefined
		: ids.length > 0
			? inArray(column as never, ids)
			: sql`false`;

const safeDeployment = (deployment: {
	deploymentId: string;
	projectId: string | null;
	environmentId: string | null;
	title: string;
	description: string | null;
	status: string | null;
	trigger: string | null;
	sourceProvider: string | null;
	sourceRevision: string | null;
	sourceBranch: string | null;
	sourceAuthor: string | null;
	sourceMessage: string | null;
	immutableUrl: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	errorCode: string | null;
	errorMessage: string | null;
	application?: { name: string; icon: string | null } | null;
	compose?: { name: string } | null;
	project?: { name: string; slug: string } | null;
	environment?: { name: string; kind: string } | null;
	previewDeployment?: {
		pullRequestNumber: string;
		pullRequestTitle: string;
		pullRequestURL: string;
		branch: string;
	} | null;
}) => ({
	deploymentId: deployment.deploymentId,
	projectId: deployment.projectId,
	environmentId: deployment.environmentId,
	projectName: deployment.project?.name ?? "Workspace operation",
	projectSlug: deployment.project?.slug ?? null,
	environmentName: deployment.environment?.name ?? null,
	environmentKind: deployment.environment?.kind ?? null,
	serviceName:
		deployment.application?.name ?? deployment.compose?.name ?? "Deployment",
	serviceIcon: deployment.application?.icon ?? null,
	title: deployment.title,
	description: deployment.description,
	status: normalizeDeploymentStatus(deployment.status),
	trigger: deployment.trigger,
	sourceProvider: deployment.sourceProvider,
	sourceRevision: deployment.sourceRevision,
	sourceBranch:
		deployment.sourceBranch ?? deployment.previewDeployment?.branch ?? null,
	sourceAuthor: deployment.sourceAuthor,
	sourceMessage: deployment.sourceMessage,
	immutableUrl: deployment.immutableUrl,
	createdAt: deployment.createdAt,
	startedAt: deployment.startedAt,
	finishedAt: deployment.finishedAt,
	errorCode: deployment.errorCode,
	errorMessage: deployment.errorMessage,
	pullRequest: deployment.previewDeployment
		? {
				number: deployment.previewDeployment.pullRequestNumber,
				title: deployment.previewDeployment.pullRequestTitle,
				url: deployment.previewDeployment.pullRequestURL,
			}
		: null,
});

const deploymentRelations = {
	application: { columns: { name: true, icon: true } },
	compose: { columns: { name: true } },
	project: { columns: { name: true, slug: true } },
	environment: { columns: { name: true, kind: true } },
	previewDeployment: {
		columns: {
			pullRequestNumber: true,
			pullRequestTitle: true,
			pullRequestURL: true,
			branch: true,
		},
	},
} as const;

const deploymentColumns = {
	deploymentId: true,
	projectId: true,
	environmentId: true,
	title: true,
	description: true,
	status: true,
	trigger: true,
	sourceProvider: true,
	sourceRevision: true,
	sourceBranch: true,
	sourceAuthor: true,
	sourceMessage: true,
	immutableUrl: true,
	createdAt: true,
	startedAt: true,
	finishedAt: true,
	errorCode: true,
	errorMessage: true,
} as const;

const getVisibleProjectIds = async (
	organizationId: string,
	access: ProductAccess,
) => {
	const rows = await db.query.projects.findMany({
		where: and(
			eq(projects.organizationId, organizationId),
			isNull(projects.deletedAt),
			projectScope(access),
		),
		columns: { projectId: true },
	});
	return rows.map((project) => project.projectId);
};

const getVisiblePreviewIds = async (
	organizationId: string,
	projectIds: string[],
	access: ProductAccess,
) => {
	if (projectIds.length === 0) return [];
	const rows = await db.query.previewDeployments.findMany({
		where: and(
			eq(previewDeployments.organizationId, organizationId),
			inArray(previewDeployments.projectId, projectIds),
			idScope(previewDeployments.environmentId, access.environmentIds),
			isNull(previewDeployments.deletedAt),
			idScope(previewDeployments.applicationId, access.serviceIds),
		),
		columns: { previewDeploymentId: true },
	});
	return rows.map((preview) => preview.previewDeploymentId);
};

const deploymentAccessScope = (
	access: ProductAccess,
	previewIds: string[],
) => {
	if (access.serviceIds === null) return undefined;
	const conditions = [];
	if (access.serviceIds.length > 0) {
		conditions.push(inArray(deployments.applicationId, access.serviceIds));
		conditions.push(inArray(deployments.composeId, access.serviceIds));
	}
	if (previewIds.length > 0) {
		conditions.push(inArray(deployments.previewDeploymentId, previewIds));
	}
	return conditions.length > 0 ? or(...conditions) : sql`false`;
};

const domainAccessScope = (access: ProductAccess, previewIds: string[]) => {
	if (access.serviceIds === null) return undefined;
	const conditions = [];
	if (access.serviceIds.length > 0) {
		conditions.push(inArray(domains.applicationId, access.serviceIds));
		conditions.push(inArray(domains.composeId, access.serviceIds));
	}
	if (previewIds.length > 0) {
		conditions.push(inArray(domains.previewDeploymentId, previewIds));
	}
	return conditions.length > 0 ? or(...conditions) : sql`false`;
};

export const getProductWorkspaceContext = async (
	organizationId: string,
	userId: string,
) => {
	const workspace = await db.query.organization.findFirst({
		where: and(
			eq(organization.id, organizationId),
			isNull(organization.deletedAt),
		),
		columns: { id: true, name: true, slug: true, logo: true, ownerId: true },
		with: {
			members: {
				where: (member, { eq }) => eq(member.userId, userId),
				columns: { id: true, role: true },
			},
		},
	});
	if (!workspace || workspace.members.length === 0 || !workspace.slug) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
	}
	return {
		id: workspace.id,
		name: workspace.name,
		slug: workspace.slug,
		logo: workspace.logo,
		ownerId: workspace.ownerId,
		role: workspace.members[0]?.role ?? "member",
	};
};

export const getProductNavigationContext = async (
	organizationId: string,
	access: ProductAccess,
) => {
	const [workspace, projectRows] = await Promise.all([
		getProductWorkspaceContext(organizationId, access.userId),
		db.query.projects.findMany({
			where: and(
				eq(projects.organizationId, organizationId),
				isNull(projects.deletedAt),
				projectScope(access),
			),
			columns: { projectId: true, slug: true, name: true },
			orderBy: desc(projects.createdAt),
		}),
	]);
	const visibleProjectIds = projectRows.map((project) => project.projectId);
	if (visibleProjectIds.length === 0) {
		return { workspace, projects: projectRows, alertCount: 0 };
	}
	const [failedRows, aliasRows] = await Promise.all([
		db.query.deployments.findMany({
			where: and(
				eq(deployments.organizationId, organizationId),
				inArray(deployments.projectId, visibleProjectIds),
				idScope(deployments.environmentId, access.environmentIds),
				inArray(deployments.status, ["failed", "error"]),
				isNull(deployments.deletedAt),
				access.serviceIds === null
					? undefined
					: access.serviceIds.length > 0
						? or(
								inArray(deployments.applicationId, access.serviceIds),
								inArray(deployments.composeId, access.serviceIds),
							)
						: sql`false`,
			),
			columns: { deploymentId: true },
			limit: 20,
		}),
		access.serviceIds !== null
			? Promise.resolve([])
			: db.query.aliases.findMany({
			where: and(
				eq(aliases.organizationId, organizationId),
				inArray(aliases.projectId, visibleProjectIds),
				eq(aliases.status, "error"),
			),
			columns: { aliasId: true },
			limit: 20,
			}),
	]);
	return {
		workspace,
		projects: projectRows,
		alertCount: failedRows.length + aliasRows.length,
	};
};

export const getProductWorkspaceOverview = async (
	organizationId: string,
	access: ProductAccess,
) => {
	const [workspace, visibleProjectIds] = await Promise.all([
		getProductWorkspaceContext(organizationId, access.userId),
		getVisibleProjectIds(organizationId, access),
	]);

	if (visibleProjectIds.length === 0) {
		return {
			workspace,
			projects: [],
			recentDeployments: [],
			recentPreviews: [],
			domains: [],
			activity: [],
			alerts: [],
			usage: {
				cycleStart: new Date(
					Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
				).toISOString(),
				builds: 0,
				deployments: 0,
				artifacts: 0,
				artifactBytes: 0,
				edgeRequests: null,
				logStreams: 0,
				limits: null,
			},
		};
	}

	const previewIds = await getVisiblePreviewIds(
		organizationId,
		visibleProjectIds,
		access,
	);
	const cycleStart = new Date(
		Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
	);
	const activityResourceIds = [
		...visibleProjectIds,
		...(access.serviceIds ?? []),
	];

	const [
		projectRows,
		deploymentRows,
		previewRows,
		domainRows,
		aliasRows,
		sourceRows,
		buildRows,
		artifactRows,
		activityRows,
	] = await Promise.all([
		db.query.projects.findMany({
			where: and(
				eq(projects.organizationId, organizationId),
				inArray(projects.projectId, visibleProjectIds),
				isNull(projects.deletedAt),
			),
			columns: {
				projectId: true,
				slug: true,
				name: true,
				description: true,
				createdAt: true,
				primaryApplicationId: true,
			},
			with: {
				projectTags: { with: { tag: true } },
				environments: {
					where: and(
						isNull(environments.deletedAt),
						idScope(environments.environmentId, access.environmentIds),
					),
					columns: {
						environmentId: true,
						name: true,
						kind: true,
					},
					with: {
						applications: {
							where: and(
								isNull(applications.deletedAt),
								idScope(applications.applicationId, access.serviceIds),
							),
							columns: {
								applicationId: true,
								name: true,
								icon: true,
								applicationStatus: true,
							},
						},
						compose: {
							where: and(
								isNull(compose.deletedAt),
								idScope(compose.composeId, access.serviceIds),
							),
							columns: {
								composeId: true,
								name: true,
								composeStatus: true,
							},
						},
						postgres: {
							where: idScope(postgres.postgresId, access.serviceIds),
							columns: { postgresId: true, name: true, applicationStatus: true },
						},
						mariadb: {
							where: idScope(mariadb.mariadbId, access.serviceIds),
							columns: { mariadbId: true, name: true, applicationStatus: true },
						},
						mysql: {
							where: idScope(mysql.mysqlId, access.serviceIds),
							columns: { mysqlId: true, name: true, applicationStatus: true },
						},
						mongo: {
							where: idScope(mongo.mongoId, access.serviceIds),
							columns: { mongoId: true, name: true, applicationStatus: true },
						},
						redis: {
							where: idScope(redis.redisId, access.serviceIds),
							columns: { redisId: true, name: true, applicationStatus: true },
						},
						libsql: {
							where: idScope(libsql.libsqlId, access.serviceIds),
							columns: { libsqlId: true, name: true, applicationStatus: true },
						},
					},
				},
			},
			orderBy: desc(projects.createdAt),
		}),
		db.query.deployments.findMany({
			where: and(
				eq(deployments.organizationId, organizationId),
				inArray(deployments.projectId, visibleProjectIds),
				idScope(deployments.environmentId, access.environmentIds),
				isNull(deployments.deletedAt),
				deploymentAccessScope(access, previewIds),
			),
			columns: deploymentColumns,
			with: deploymentRelations,
			orderBy: desc(deployments.createdAt),
			limit: 80,
		}),
		db.query.previewDeployments.findMany({
			where: and(
				eq(previewDeployments.organizationId, organizationId),
				inArray(previewDeployments.projectId, visibleProjectIds),
				idScope(previewDeployments.environmentId, access.environmentIds),
				isNull(previewDeployments.deletedAt),
				idScope(previewDeployments.applicationId, access.serviceIds),
			),
			columns: {
				previewDeploymentId: true,
				projectId: true,
				branch: true,
				pullRequestNumber: true,
				pullRequestTitle: true,
				pullRequestURL: true,
				previewStatus: true,
				createdAt: true,
			},
			with: {
				project: { columns: { name: true, slug: true } },
				application: { columns: { name: true, icon: true } },
				domain: { columns: { host: true, https: true } },
			},
			orderBy: desc(previewDeployments.createdAt),
			limit: 12,
		}),
		db.query.domains.findMany({
			where: and(
				eq(domains.organizationId, organizationId),
				inArray(domains.projectId, visibleProjectIds),
				idScope(domains.environmentId, access.environmentIds),
				isNull(domains.deletedAt),
				domainAccessScope(access, previewIds),
			),
			columns: {
				domainId: true,
				projectId: true,
				environmentId: true,
				host: true,
				https: true,
				path: true,
				domainType: true,
				createdAt: true,
			},
			with: {
				project: { columns: { name: true, slug: true } },
				environment: { columns: { name: true, kind: true } },
			},
		}),
		db.query.aliases.findMany({
			where: and(
				eq(aliases.organizationId, organizationId),
				inArray(aliases.projectId, visibleProjectIds),
				idScope(aliases.environmentId, access.environmentIds),
				access.serviceIds === null ? undefined : sql`false`,
			),
			columns: {
				aliasId: true,
				projectId: true,
				environmentId: true,
				releaseId: true,
				kind: true,
				status: true,
				hostname: true,
				branch: true,
				version: true,
				lastError: true,
				updatedAt: true,
			},
		}),
		access.serviceIds !== null
			? Promise.resolve([])
			: db.query.projectSources.findMany({
					where: and(
						eq(projectSources.organizationId, organizationId),
						inArray(projectSources.projectId, visibleProjectIds),
						eq(projectSources.enabled, true),
					),
					columns: {
						projectId: true,
						provider: true,
						repositoryOwner: true,
						repositoryName: true,
						defaultBranch: true,
						rootDirectory: true,
					},
				}),
		access.serviceIds !== null ? Promise.resolve([]) : db.query.builds.findMany({
			where: and(
				eq(builds.organizationId, organizationId),
				inArray(builds.projectId, visibleProjectIds),
				gte(builds.createdAt, cycleStart),
			),
			columns: {
				buildId: true,
				projectId: true,
				deploymentId: true,
				status: true,
				createdAt: true,
			},
		}),
		access.serviceIds !== null ? Promise.resolve([]) : db.query.artifacts.findMany({
			where: and(
				eq(artifacts.organizationId, organizationId),
				inArray(artifacts.projectId, visibleProjectIds),
				isNull(artifacts.deletedAt),
			),
			columns: {
				artifactId: true,
				projectId: true,
				buildId: true,
				sizeBytes: true,
				createdAt: true,
				status: true,
			},
		}),
		db.query.auditLog.findMany({
			where: and(
				eq(auditLog.organizationId, organizationId),
				...(access.projectIds === null
					? []
					: [
							or(
								eq(auditLog.userId, access.userId),
								...(activityResourceIds.length > 0
									? [inArray(auditLog.resourceId, activityResourceIds)]
									: []),
							),
						]),
			),
			columns: {
				id: true,
				userEmail: true,
				userRole: true,
				action: true,
				resourceType: true,
				resourceId: true,
				resourceName: true,
				createdAt: true,
			},
			orderBy: desc(auditLog.createdAt),
			limit: 40,
		}),
	]);

	const safeDeployments = deploymentRows.map(safeDeployment);
	const visibleDeploymentIds = new Set(
		safeDeployments.map((deployment) => deployment.deploymentId),
	);
	const visibleBuildRows =
		access.serviceIds === null
			? buildRows
			: buildRows.filter((build) =>
					visibleDeploymentIds.has(build.deploymentId),
				);
	const visibleBuildIds = new Set(
		visibleBuildRows.map((build) => build.buildId),
	);
	const visibleArtifactRows =
		access.serviceIds === null
			? artifactRows
			: artifactRows.filter((artifact) =>
					visibleBuildIds.has(artifact.buildId),
				);
	const deploymentByProject = new Map<string, (typeof safeDeployments)[number]>();
	for (const deployment of safeDeployments) {
		if (deployment.projectId && !deploymentByProject.has(deployment.projectId)) {
			deploymentByProject.set(deployment.projectId, deployment);
		}
	}
	const sourceByProject = new Map(sourceRows.map((source) => [source.projectId, source]));
	const productionAliasByProject = new Map(
		aliasRows
			.filter((alias) => alias.kind === "production" && alias.status !== "disabled")
			.map((alias) => [alias.projectId, alias]),
	);
	const domainByProject = new Map<string, (typeof domainRows)[number]>();
	for (const domain of domainRows) {
		if (!domain.projectId || domainByProject.has(domain.projectId)) continue;
		if (domain.environment?.kind === "production") {
			domainByProject.set(domain.projectId, domain);
		}
	}
	const previewsByProject = new Set(previewRows.map((preview) => preview.projectId));
	const deploymentProjects = new Set(safeDeployments.map((deployment) => deployment.projectId));

	const projectCards = projectRows.map((project) => {
		const serviceCount = project.environments.reduce(
			(total, environment) =>
				total +
				environment.applications.length +
				environment.compose.length +
				environment.postgres.length +
				environment.mariadb.length +
				environment.mysql.length +
				environment.mongo.length +
				environment.redis.length +
				environment.libsql.length,
			0,
		);
		const source = sourceByProject.get(project.projectId) ?? null;
		const productionAlias = productionAliasByProject.get(project.projectId) ?? null;
		const productionDomain = domainByProject.get(project.projectId) ?? null;
		const setupSteps = [
			Boolean(source),
			Boolean(productionDomain || productionAlias),
			previewsByProject.has(project.projectId),
			deploymentProjects.has(project.projectId),
			serviceCount > 1,
		];
		return {
			projectId: project.projectId,
			slug: project.slug,
			name: project.name,
			description: project.description,
			createdAt: project.createdAt,
			tags: project.projectTags.map(({ tag }) => ({
				id: tag.tagId,
				name: tag.name,
				color: tag.color,
			})),
			environmentCount: project.environments.length,
			serviceCount,
			latestDeployment: deploymentByProject.get(project.projectId) ?? null,
			productionDomain: productionAlias?.hostname ?? productionDomain?.host ?? null,
			repository: source
				? {
						provider: source.provider,
						owner: source.repositoryOwner,
						name: source.repositoryName,
						branch: source.defaultBranch,
						rootDirectory: source.rootDirectory,
					}
				: null,
			setup: {
				completed: setupSteps.filter(Boolean).length,
				total: setupSteps.length,
			},
		};
	});

	const alerts = [
		...safeDeployments
			.filter((deployment) => deployment.status === "failed")
			.slice(0, 4)
			.map((deployment) => ({
				id: `deployment:${deployment.deploymentId}`,
				severity: "error" as const,
				title: `${deployment.projectName} deployment failed`,
				detail:
					deployment.errorMessage || deployment.sourceMessage || deployment.title,
				projectSlug: deployment.projectSlug,
				createdAt: deployment.createdAt,
			})),
		...aliasRows
			.filter((alias) => alias.status === "error")
			.slice(0, 4)
			.map((alias) => ({
				id: `alias:${alias.aliasId}`,
				severity: "warning" as const,
				title: `${alias.hostname} needs attention`,
				detail: alias.lastError || "The domain route could not be reconciled.",
				projectSlug:
					projectRows.find((project) => project.projectId === alias.projectId)
						?.slug ?? null,
				createdAt: alias.updatedAt.toISOString(),
			})),
	];

	return {
		workspace,
		projects: projectCards,
		recentDeployments: safeDeployments.slice(0, 20),
		recentPreviews: previewRows.map((preview) => {
			const latestDeployment = safeDeployments.find(
				(deployment) =>
					deployment.pullRequest?.number === preview.pullRequestNumber &&
					deployment.projectId === preview.projectId,
			);
			return {
				previewDeploymentId: preview.previewDeploymentId,
				projectName: preview.project.name,
				projectSlug: preview.project.slug,
				serviceName: preview.application.name,
				serviceIcon: preview.application.icon,
				branch: preview.branch,
				pullRequestNumber: preview.pullRequestNumber,
				pullRequestTitle: preview.pullRequestTitle,
				pullRequestURL: preview.pullRequestURL,
				status: normalizeDeploymentStatus(
					latestDeployment?.status ?? preview.previewStatus,
				),
				author: latestDeployment?.sourceAuthor ?? null,
				commit: latestDeployment?.sourceRevision ?? null,
				deploymentId: latestDeployment?.deploymentId ?? null,
				immutableUrl: latestDeployment?.immutableUrl ?? null,
				previewUrl: preview.domain
					? `${preview.domain.https ? "https" : "http"}://${preview.domain.host}`
					: latestDeployment?.immutableUrl ?? null,
				createdAt: preview.createdAt,
			};
		}),
		domains: domainRows.map((domain) => ({
			domainId: domain.domainId,
			projectId: domain.projectId,
			projectName: domain.project?.name ?? "Unknown project",
			projectSlug: domain.project?.slug ?? null,
			environmentName: domain.environment?.name ?? null,
			environmentKind: domain.environment?.kind ?? null,
			host: domain.host,
			https: domain.https,
			path: domain.path,
			type: domain.domainType,
			createdAt: domain.createdAt,
		})),
		activity: activityRows
			.filter((entry) => !hiddenActivityTypes.has(entry.resourceType))
			.map((entry) => ({
				id: entry.id,
				actor: entry.userEmail,
				actorRole: entry.userRole,
				action: entry.action,
				resourceType: entry.resourceType,
				resourceId: entry.resourceId,
				resourceName: entry.resourceName,
				createdAt: entry.createdAt.toISOString(),
			})),
		alerts,
		usage: {
			cycleStart: cycleStart.toISOString(),
			builds: visibleBuildRows.length,
			deployments: safeDeployments.filter(
				(deployment) => new Date(deployment.createdAt) >= cycleStart,
			).length,
			artifacts: visibleArtifactRows.length,
			artifactBytes: visibleArtifactRows.reduce(
				(total, artifact) => total + (artifact.sizeBytes ?? 0),
				0,
			),
			edgeRequests: null,
			logStreams: safeDeployments.filter(
				(deployment) => new Date(deployment.createdAt) >= cycleStart,
			).length,
			limits: null,
		},
	};
};

const metric = (
	value: Record<string, unknown> | null,
	keys: string[],
): number | null => {
	for (const key of keys) {
		const candidate = value?.[key];
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return candidate;
		}
	}
	return null;
};

export const getProductProjectOverview = async (
	organizationId: string,
	projectSlug: string,
	access: ProductAccess,
) => {
	const workspaceOverview = await getProductWorkspaceOverview(
		organizationId,
		access,
	);
	const projectCard = workspaceOverview.projects.find(
		(project) => project.slug === projectSlug,
	);
	if (!projectCard) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
	}
	const projectId = projectCard.projectId;
	const previewIds = await getVisiblePreviewIds(
		organizationId,
		[projectId],
		access,
	);

	const [
		project,
		deploymentRows,
		aliasRows,
		domainRows,
		source,
		releaseRows,
		variableRows,
		historyRows,
	] = await Promise.all([
		db.query.projects.findFirst({
			where: and(
				eq(projects.projectId, projectId),
				eq(projects.organizationId, organizationId),
				isNull(projects.deletedAt),
			),
			columns: {
				projectId: true,
				slug: true,
				name: true,
				description: true,
				createdAt: true,
				primaryApplicationId: true,
			},
			with: {
				environments: {
					where: and(
						isNull(environments.deletedAt),
						idScope(environments.environmentId, access.environmentIds),
					),
					columns: {
						environmentId: true,
						name: true,
						kind: true,
						branchPattern: true,
						protectionPolicy: true,
						retentionDays: true,
					},
					with: {
						applications: {
							where: and(
								isNull(applications.deletedAt),
								idScope(applications.applicationId, access.serviceIds),
							),
							columns: {
								applicationId: true,
								name: true,
								description: true,
								icon: true,
								applicationStatus: true,
								sourceType: true,
							},
						},
						compose: {
							where: and(
								isNull(compose.deletedAt),
								idScope(compose.composeId, access.serviceIds),
							),
							columns: {
								composeId: true,
								name: true,
								description: true,
								composeStatus: true,
							},
						},
						postgres: {
							where: idScope(postgres.postgresId, access.serviceIds),
							columns: { postgresId: true, name: true, description: true, applicationStatus: true },
						},
						mariadb: {
							where: idScope(mariadb.mariadbId, access.serviceIds),
							columns: { mariadbId: true, name: true, description: true, applicationStatus: true },
						},
						mysql: {
							where: idScope(mysql.mysqlId, access.serviceIds),
							columns: { mysqlId: true, name: true, description: true, applicationStatus: true },
						},
						mongo: {
							where: idScope(mongo.mongoId, access.serviceIds),
							columns: { mongoId: true, name: true, description: true, applicationStatus: true },
						},
						redis: {
							where: idScope(redis.redisId, access.serviceIds),
							columns: { redisId: true, name: true, description: true, applicationStatus: true },
						},
						libsql: {
							where: idScope(libsql.libsqlId, access.serviceIds),
							columns: { libsqlId: true, name: true, description: true, applicationStatus: true },
						},
					},
				},
			},
		}),
		db.query.deployments.findMany({
			where: and(
				eq(deployments.organizationId, organizationId),
				eq(deployments.projectId, projectId),
				idScope(deployments.environmentId, access.environmentIds),
				isNull(deployments.deletedAt),
				deploymentAccessScope(access, previewIds),
			),
			columns: deploymentColumns,
			with: deploymentRelations,
			orderBy: desc(deployments.createdAt),
			limit: 100,
		}),
		db.query.aliases.findMany({
			where: and(
				eq(aliases.organizationId, organizationId),
				eq(aliases.projectId, projectId),
				idScope(aliases.environmentId, access.environmentIds),
				access.serviceIds === null ? undefined : sql`false`,
			),
			columns: {
				aliasId: true,
				environmentId: true,
				releaseId: true,
				kind: true,
				status: true,
				hostname: true,
				branch: true,
				version: true,
				lastError: true,
				createdAt: true,
				updatedAt: true,
			},
		}),
		db.query.domains.findMany({
			where: and(
				eq(domains.organizationId, organizationId),
				eq(domains.projectId, projectId),
				idScope(domains.environmentId, access.environmentIds),
				isNull(domains.deletedAt),
				domainAccessScope(access, previewIds),
			),
			columns: {
				domainId: true,
				environmentId: true,
				host: true,
				https: true,
				path: true,
				domainType: true,
				createdAt: true,
			},
			with: { environment: { columns: { name: true, kind: true } } },
		}),
		access.serviceIds !== null ? Promise.resolve(undefined) : db.query.projectSources.findFirst({
			where: and(
				eq(projectSources.organizationId, organizationId),
				eq(projectSources.projectId, projectId),
				eq(projectSources.enabled, true),
			),
			columns: {
				provider: true,
				repositoryOwner: true,
				repositoryName: true,
				repositoryId: true,
				defaultBranch: true,
				rootDirectory: true,
				autoDeployPolicy: true,
				detectorVersion: true,
				detectorResult: true,
			},
		}),
		db.query.releases.findMany({
			where: and(
				eq(releases.organizationId, organizationId),
				eq(releases.projectId, projectId),
				idScope(releases.environmentId, access.environmentIds),
				access.serviceIds === null ? undefined : sql`false`,
			),
			columns: {
				releaseId: true,
				deploymentId: true,
				environmentId: true,
				status: true,
				healthResult: true,
				failureCode: true,
				failureMessage: true,
				createdAt: true,
				readyAt: true,
				failedAt: true,
				retiredAt: true,
			},
			orderBy: desc(releases.createdAt),
			limit: 100,
		}),
		db.query.environmentVariables.findMany({
			where: and(
				eq(environmentVariables.organizationId, organizationId),
				eq(environmentVariables.projectId, projectId),
				idScope(
					environmentVariables.environmentId,
					access.environmentIds,
				),
				isNull(environmentVariables.deletedAt),
			),
			columns: {
				environmentVariableId: true,
				environmentId: true,
				scope: true,
				key: true,
				exposure: true,
				sensitive: true,
				currentVersion: true,
				updatedAt: true,
			},
		}),
		db.query.aliasHistory.findMany({
			where: eq(aliasHistory.organizationId, organizationId),
			columns: {
				aliasId: true,
				previousReleaseId: true,
				nextReleaseId: true,
				previousVersion: true,
				nextVersion: true,
				createdAt: true,
			},
			orderBy: desc(aliasHistory.createdAt),
		}),
	]);

	if (!project) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
	}
	const safeDeployments = deploymentRows.map(safeDeployment);
	const productionEnvironment = project.environments.find(
		(environment) => environment.kind === "production",
	);
	const productionDeployment =
		safeDeployments.find(
			(deployment) =>
				deployment.environmentId === productionEnvironment?.environmentId,
		) ?? null;
	const productionAlias =
		aliasRows.find(
			(alias) => alias.kind === "production" && alias.status !== "disabled",
		) ?? null;
	const productionDomain =
		domainRows.find((domain) => domain.environment?.kind === "production") ??
		null;
	const rollbackHistory = productionAlias
		? historyRows.find(
				(history) =>
					history.aliasId === productionAlias.aliasId &&
					history.nextReleaseId === productionAlias.releaseId &&
					history.previousReleaseId,
			)
		: null;
	const rollbackRelease = rollbackHistory?.previousReleaseId
		? releaseRows.find(
				(release) =>
					release.releaseId === rollbackHistory.previousReleaseId &&
					release.status === "ready",
			)
		: null;

	const resources = project.environments.flatMap((environment) => [
		...environment.applications.map((resource) => ({
			id: resource.applicationId,
			type: "application" as const,
			name: resource.name,
			description: resource.description,
			status: resource.applicationStatus,
			icon: resource.icon,
			environmentId: environment.environmentId,
			environmentName: environment.name,
			environmentKind: environment.kind,
		})),
		...environment.compose.map((resource) => ({
			id: resource.composeId,
			type: "compose" as const,
			name: resource.name,
			description: resource.description,
			status: resource.composeStatus,
			icon: null,
			environmentId: environment.environmentId,
			environmentName: environment.name,
			environmentKind: environment.kind,
		})),
		...environment.postgres.map((resource) => ({
			id: resource.postgresId,
			type: "postgres" as const,
			name: resource.name,
			description: resource.description,
			status: resource.applicationStatus,
			icon: null,
			environmentId: environment.environmentId,
			environmentName: environment.name,
			environmentKind: environment.kind,
		})),
		...environment.mariadb.map((resource) => ({
			id: resource.mariadbId,
			type: "mariadb" as const,
			name: resource.name,
			description: resource.description,
			status: resource.applicationStatus,
			icon: null,
			environmentId: environment.environmentId,
			environmentName: environment.name,
			environmentKind: environment.kind,
		})),
		...environment.mysql.map((resource) => ({
			id: resource.mysqlId,
			type: "mysql" as const,
			name: resource.name,
			description: resource.description,
			status: resource.applicationStatus,
			icon: null,
			environmentId: environment.environmentId,
			environmentName: environment.name,
			environmentKind: environment.kind,
		})),
		...environment.mongo.map((resource) => ({
			id: resource.mongoId,
			type: "mongo" as const,
			name: resource.name,
			description: resource.description,
			status: resource.applicationStatus,
			icon: null,
			environmentId: environment.environmentId,
			environmentName: environment.name,
			environmentKind: environment.kind,
		})),
		...environment.redis.map((resource) => ({
			id: resource.redisId,
			type: "redis" as const,
			name: resource.name,
			description: resource.description,
			status: resource.applicationStatus,
			icon: null,
			environmentId: environment.environmentId,
			environmentName: environment.name,
			environmentKind: environment.kind,
		})),
		...environment.libsql.map((resource) => ({
			id: resource.libsqlId,
			type: "libsql" as const,
			name: resource.name,
			description: resource.description,
			status: resource.applicationStatus,
			icon: null,
			environmentId: environment.environmentId,
			environmentName: environment.name,
			environmentKind: environment.kind,
		})),
	]);

	const healthRows = releaseRows
		.filter((release) => release.status === "ready" && release.healthResult)
		.map((release) => release.healthResult as Record<string, unknown>);
	const sumMetric = (keys: string[]) => {
		const values = healthRows
			.map((health) => metric(health, keys))
			.filter((value): value is number => value !== null);
		return values.length > 0
			? values.reduce((total, value) => total + value, 0)
			: null;
	};
	const averageMetric = (keys: string[]) => {
		const values = healthRows
			.map((health) => metric(health, keys))
			.filter((value): value is number => value !== null);
		return values.length > 0
			? values.reduce((total, value) => total + value, 0) / values.length
			: null;
	};

	const branches = new Map<
		string,
		{
			branch: string;
			alias: string | null;
			aliasStatus: string | null;
			deployment: (typeof safeDeployments)[number] | null;
			pullRequest: (typeof safeDeployments)[number]["pullRequest"];
		}
	>();
	for (const alias of aliasRows) {
		if (!alias.branch) continue;
		branches.set(alias.branch, {
			branch: alias.branch,
			alias: alias.hostname,
			aliasStatus: alias.status,
			deployment: null,
			pullRequest: null,
		});
	}
	for (const deployment of safeDeployments) {
		if (!deployment.sourceBranch) continue;
		const current = branches.get(deployment.sourceBranch) ?? {
			branch: deployment.sourceBranch,
			alias: null,
			aliasStatus: null,
			deployment: null,
			pullRequest: null,
		};
		if (!current.deployment) current.deployment = deployment;
		if (!current.pullRequest && deployment.pullRequest) {
			current.pullRequest = deployment.pullRequest;
		}
		branches.set(deployment.sourceBranch, current);
	}

	const setup = [
		{ key: "git", label: "Connect source", complete: Boolean(source) },
		{
			key: "domain",
			label: "Add a production domain",
			complete: Boolean(productionDomain || productionAlias),
		},
		{
			key: "preview",
			label: "Create the first preview",
			complete: previewIds.length > 0,
		},
		{
			key: "logs",
			label: "Inspect a deployment log",
			complete: safeDeployments.length > 0,
		},
		{
			key: "resource",
			label: "Connect an optional resource",
			complete: resources.some((resource) => resource.type !== "application"),
		},
	];

	return {
		workspace: workspaceOverview.workspace,
		project: {
			projectId: project.projectId,
			slug: project.slug,
			name: project.name,
			description: project.description,
			createdAt: project.createdAt,
		},
		source: source
			? {
					provider: source.provider,
					owner: source.repositoryOwner,
					name: source.repositoryName,
					id: source.repositoryId,
					branch: source.defaultBranch,
					rootDirectory: source.rootDirectory,
					autoDeployPolicy: source.autoDeployPolicy,
					detectorVersion: source.detectorVersion,
					detectorResult: source.detectorResult,
				}
			: null,
		production: {
			environment: productionEnvironment
				? {
						environmentId: productionEnvironment.environmentId,
						name: productionEnvironment.name,
						kind: productionEnvironment.kind,
					}
				: null,
			deployment: productionDeployment,
			alias: productionAlias
				? {
						aliasId: productionAlias.aliasId,
						hostname: productionAlias.hostname,
						status: productionAlias.status,
						version: productionAlias.version,
					}
				: null,
			domain: productionDomain
				? {
						host: productionDomain.host,
						https: productionDomain.https,
					}
				: null,
			visitUrl: productionAlias
				? `https://${productionAlias.hostname}`
				: productionDomain
					? `${productionDomain.https ? "https" : "http"}://${productionDomain.host}`
					: productionDeployment?.immutableUrl ?? null,
			canRollback: Boolean(rollbackRelease),
			rollbackReleaseId: rollbackRelease?.releaseId ?? null,
		},
		setup: {
			items: setup,
			completed: setup.filter((item) => item.complete).length,
			total: setup.length,
		},
		observability: {
			requests: sumMetric(["requests", "requestCount"]),
			errorRate: averageMetric(["errorRate", "errorsPercent"]),
			latencyMs: averageMetric(["latencyMs", "responseTimeMs"]),
			restarts: sumMetric(["restarts", "restartCount"]),
			sampleCount: healthRows.length,
		},
		branches: [...branches.values()],
		deployments: safeDeployments,
		domains: domainRows.map((domain) => ({
			domainId: domain.domainId,
			host: domain.host,
			https: domain.https,
			path: domain.path,
			type: domain.domainType,
			environmentId: domain.environmentId,
			environmentName: domain.environment?.name ?? null,
			environmentKind: domain.environment?.kind ?? null,
			createdAt: domain.createdAt,
		})),
		aliases: aliasRows.map((alias) => ({
			aliasId: alias.aliasId,
			hostname: alias.hostname,
			branch: alias.branch,
			kind: alias.kind,
			status: alias.status,
			version: alias.version,
			lastError: alias.lastError,
		})),
		resources,
		environments: project.environments.map((environment) => ({
			environmentId: environment.environmentId,
			name: environment.name,
			kind: environment.kind,
			branchPattern: environment.branchPattern,
			protectionPolicy: environment.protectionPolicy,
			retentionDays: environment.retentionDays,
		})),
		variables: variableRows.map((variable) => ({
			environmentVariableId: variable.environmentVariableId,
			environmentId: variable.environmentId,
			scope: variable.scope,
			key: variable.key,
			exposure: variable.exposure,
			sensitive: variable.sensitive,
			currentVersion: variable.currentVersion,
			updatedAt: variable.updatedAt.toISOString(),
		})),
	};
};

export const getProductDeploymentDetail = async (
	organizationId: string,
	projectSlug: string,
	deploymentId: string,
	access: ProductAccess,
) => {
	const overview = await getProductProjectOverview(
		organizationId,
		projectSlug,
		access,
	);
	const deployment = overview.deployments.find(
		(candidate) => candidate.deploymentId === deploymentId,
	);
	if (!deployment) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Deployment not found" });
	}
	const [buildRows, releaseRows] = await Promise.all([
		db.query.builds.findMany({
			where: and(
				eq(builds.organizationId, organizationId),
				eq(builds.projectId, overview.project.projectId),
				eq(builds.deploymentId, deploymentId),
			),
			columns: {
				buildId: true,
				status: true,
				attempt: true,
				preset: true,
				errorCode: true,
				errorMessage: true,
				queuedAt: true,
				startedAt: true,
				finishedAt: true,
			},
		}),
		db.query.releases.findMany({
			where: and(
				eq(releases.organizationId, organizationId),
				eq(releases.projectId, overview.project.projectId),
				eq(releases.deploymentId, deploymentId),
			),
			columns: {
				releaseId: true,
				status: true,
				attempt: true,
				healthResult: true,
				failureCode: true,
				failureMessage: true,
				createdAt: true,
				readyAt: true,
				failedAt: true,
				retiredAt: true,
			},
		}),
	]);
	const buildIds = buildRows.map((build) => build.buildId);
	const artifactRows =
		buildIds.length === 0
			? []
			: await db.query.artifacts.findMany({
					where: and(
						eq(artifacts.organizationId, organizationId),
						eq(artifacts.projectId, overview.project.projectId),
						inArray(artifacts.buildId, buildIds),
						isNull(artifacts.deletedAt),
					),
					columns: {
						artifactId: true,
						buildId: true,
						type: true,
						status: true,
						digest: true,
						sizeBytes: true,
						createdAt: true,
					},
				});
	return {
		...overview,
		deployment,
		builds: buildRows.map((build) => ({
			...build,
			artifacts: artifactRows.filter(
				(artifact) => artifact.buildId === build.buildId,
			),
		})),
		releases: releaseRows,
	};
};
