import {
	execAsync,
	execAsyncRemote,
	findAllDeploymentsByApplicationId,
	findAllDeploymentsByComposeId,
	findAllDeploymentsByServerId,
	findAllDeploymentsCentralized,
	findBackupById,
	findDeploymentById,
	findPreviewDeploymentById,
	findScheduleById,
	findVolumeBackupById,
	IS_CLOUD,
	removeDeployment,
	resolveServicePath,
	transitionDeployment,
	updateDeploymentStatus,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { findServerById } from "@dokploy/server/services/server";
import { assertWorkspaceResource } from "@dokploy/server/services/tenancy";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	apiFindAllByApplication,
	apiFindAllByCompose,
	apiFindAllByServer,
	apiFindAllByType,
	deployments,
	server,
} from "@/server/db/schema";
import { myQueue } from "@/server/queues/queueSetup";
import { fetchDeployApiJobs, type QueueJobRow } from "@/server/utils/deploy";
import {
	assertOperatorRequest,
	createTRPCRouter,
	operatorProcedure,
	protectedProcedure,
	withPermission,
} from "../trpc";

type DeploymentPermissionContext = Parameters<
	typeof checkServicePermissionAndAccess
>[0] & { req: Parameters<typeof assertOperatorRequest>[0] };
type DeploymentRecord = Awaited<ReturnType<typeof findDeploymentById>>;

const authorizeServerTarget = async (
	ctx: DeploymentPermissionContext,
	serverId: string,
) => {
	assertOperatorRequest(ctx.req);
	const targetServer = await findServerById(serverId);
	if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
	}
};

const authorizeServiceTarget = async (
	ctx: DeploymentPermissionContext,
	serviceId: string,
	action: "read" | "cancel",
) => {
	await checkServicePermissionAndAccess(ctx, serviceId, {
		deployment: [action],
	});
};

const authorizeBackupTarget = async (
	ctx: DeploymentPermissionContext,
	backupId: string,
	action: "read" | "cancel",
) => {
	const backup = await findBackupById(backupId);
	const serviceId =
		backup.composeId ||
		backup.postgresId ||
		backup.mysqlId ||
		backup.mariadbId ||
		backup.mongoId ||
		backup.libsqlId;
	if (!serviceId) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Backup has no owner" });
	}
	await authorizeServiceTarget(ctx, serviceId, action);
};

const authorizeVolumeBackupTarget = async (
	ctx: DeploymentPermissionContext,
	volumeBackupId: string,
	action: "read" | "cancel",
) => {
	const backup = await findVolumeBackupById(volumeBackupId);
	const serviceId =
		backup.applicationId ||
		backup.composeId ||
		backup.postgresId ||
		backup.mysqlId ||
		backup.mariadbId ||
		backup.mongoId ||
		backup.redisId ||
		backup.libsqlId;
	if (!serviceId) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Backup has no owner" });
	}
	await authorizeServiceTarget(ctx, serviceId, action);
};

const authorizeScheduleTarget = async (
	ctx: DeploymentPermissionContext,
	scheduleId: string,
	action: "read" | "cancel",
) => {
	const schedule = await findScheduleById(scheduleId);
	const serviceId = schedule.applicationId || schedule.composeId;
	if (serviceId) {
		await authorizeServiceTarget(ctx, serviceId, action);
		return;
	}
	if (schedule.serverId) {
		await authorizeServerTarget(ctx, schedule.serverId);
		return;
	}
	throw new TRPCError({ code: "FORBIDDEN", message: "Schedule has no owner" });
};

const authorizeDeploymentTarget = async (
	ctx: DeploymentPermissionContext,
	deployment: DeploymentRecord,
	action: "read" | "cancel",
) => {
	const serviceId = deployment.applicationId || deployment.composeId;
	if (serviceId) return authorizeServiceTarget(ctx, serviceId, action);
	if (deployment.previewDeploymentId) {
		const preview = await findPreviewDeploymentById(
			deployment.previewDeploymentId,
		);
		return authorizeServiceTarget(ctx, preview.applicationId, action);
	}
	if (deployment.backupId) {
		return authorizeBackupTarget(ctx, deployment.backupId, action);
	}
	if (deployment.volumeBackupId) {
		return authorizeVolumeBackupTarget(ctx, deployment.volumeBackupId, action);
	}
	if (deployment.scheduleId) {
		return authorizeScheduleTarget(ctx, deployment.scheduleId, action);
	}
	const directServerId = deployment.serverId || deployment.buildServerId;
	if (directServerId) {
		return authorizeServerTarget(ctx, directServerId);
	}
	throw new TRPCError({ code: "FORBIDDEN", message: "Deployment has no owner" });
};

export const deploymentRouter = createTRPCRouter({
	all: protectedProcedure
		.input(apiFindAllByApplication)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["read"],
			});
			return await findAllDeploymentsByApplicationId(input.applicationId);
		}),

	allByCompose: protectedProcedure
		.input(apiFindAllByCompose)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["read"],
			});
			return await findAllDeploymentsByComposeId(input.composeId);
		}),
	allByServer: operatorProcedure
		.input(apiFindAllByServer)
		.query(async ({ input, ctx }) => {
			const targetServer = await findServerById(input.serverId);
			if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this server.",
				});
			}
			return await findAllDeploymentsByServerId(input.serverId);
		}),
	allCentralized: withPermission("deployment", "read").query(
		async ({ ctx }) => {
			const orgId = ctx.session.activeOrganizationId;
			const accessedServices =
				ctx.user.role !== "owner" && ctx.user.role !== "admin"
					? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
					: null;
			if (accessedServices !== null && accessedServices.length === 0) {
				return [];
			}
			return findAllDeploymentsCentralized(orgId, accessedServices);
		},
	),

	queueList: withPermission("deployment", "read").query(async ({ ctx }) => {
		const orgId = ctx.session.activeOrganizationId;
		let rows: QueueJobRow[];

		if (IS_CLOUD) {
			const servers = await db.query.server.findMany({
				where: and(
					eq(server.organizationId, orgId),
					isNull(server.deletedAt),
				),
				columns: { serverId: true },
			});
			const serverRowsArrays = await Promise.all(
				servers.map(({ serverId }) => fetchDeployApiJobs(serverId)),
			);
			rows = serverRowsArrays.flat();
			rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
		} else {
			const jobs = await myQueue.getJobs();
			const jobRows = await Promise.all(
				jobs.map(async (job) => {
					const state = await job.getState();
					return {
						id: String(job.id),
						name: job.name ?? undefined,
						data: job.data as Record<string, unknown>,
						timestamp: job.timestamp,
						processedOn: job.processedOn,
						finishedOn: job.finishedOn,
						failedReason: job.failedReason ?? undefined,
						state,
					};
				}),
			);
			jobRows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
			rows = jobRows;
		}

		return Promise.all(
			rows.map(async (row) => ({
				...row,
				servicePath: await resolveServicePath(
					orgId,
					(row.data ?? {}) as Record<string, unknown>,
				),
			})),
		);
	}),

	allByType: protectedProcedure
		.input(apiFindAllByType)
		.query(async ({ input, ctx }) => {
			switch (input.type) {
				case "application":
				case "compose":
					await authorizeServiceTarget(ctx, input.id, "read");
					break;
				case "previewDeployment": {
					const preview = await findPreviewDeploymentById(input.id);
					await authorizeServiceTarget(ctx, preview.applicationId, "read");
					break;
				}
				case "schedule":
					await authorizeScheduleTarget(ctx, input.id, "read");
					break;
				case "backup":
					await authorizeBackupTarget(ctx, input.id, "read");
					break;
				case "volumeBackup":
					await authorizeVolumeBackupTarget(ctx, input.id, "read");
					break;
				case "server":
					await authorizeServerTarget(ctx, input.id);
					break;
			}
			const deploymentsList = await db.query.deployments.findMany({
				where: and(
					eq(deployments[`${input.type}Id`], input.id),
					eq(deployments.organizationId, ctx.session.activeOrganizationId),
				),
				orderBy: desc(deployments.createdAt),
				with: {
					rollback: true,
				},
			});
			return deploymentsList;
		}),
	killProcess: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			assertWorkspaceResource(
				ctx.session.activeOrganizationId,
				deployment,
				"Deployment",
			);
			await authorizeDeploymentTarget(ctx, deployment, "cancel");

			if (!deployment.pid) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Deployment is not running",
				});
			}
			if (!/^\d+$/.test(deployment.pid)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Deployment process identifier is invalid",
				});
			}
			if (
				!deployment.status ||
				!["running", "preparing", "building", "deploying", "checking"].includes(
					deployment.status,
				)
			) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Only an active deployment can be cancelled",
				});
			}
			const legacyRunning = deployment.status === "running";
			if (!legacyRunning) {
				await transitionDeployment({
					organizationId: ctx.session.activeOrganizationId,
					deploymentId: deployment.deploymentId,
					expectedStatus: deployment.status as
						| "preparing"
						| "building"
						| "deploying"
						| "checking",
					nextStatus: "cancelling",
				});
			}

			try {
				const command = `kill -9 ${deployment.pid}`;
				if (deployment.schedule?.serverId) {
					await execAsyncRemote(deployment.schedule.serverId, command);
				} else {
					await execAsync(command);
				}
				if (legacyRunning) {
					await updateDeploymentStatus(deployment.deploymentId, "cancelled");
				} else {
					await transitionDeployment({
						organizationId: ctx.session.activeOrganizationId,
						deploymentId: deployment.deploymentId,
						expectedStatus: "cancelling",
						nextStatus: "cancelled",
					});
				}
			} catch (error) {
				if (!legacyRunning) {
					await transitionDeployment({
						organizationId: ctx.session.activeOrganizationId,
						deploymentId: deployment.deploymentId,
						expectedStatus: "cancelling",
						nextStatus: "failed",
						errorCode: "cancel_failed",
						errorMessage:
							error instanceof Error ? error.message : "Cancellation failed",
					});
				}
				throw error;
			}

			await audit(ctx, {
				action: "cancel",
				resourceType: "deployment",
				resourceId: deployment.deploymentId,
			});
		}),

	removeDeployment: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			assertWorkspaceResource(
				ctx.session.activeOrganizationId,
				deployment,
				"Deployment",
			);
			await authorizeDeploymentTarget(ctx, deployment, "cancel");
			const result = await removeDeployment(
				input.deploymentId,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "deployment",
				resourceId: deployment.deploymentId,
			});
			return result;
		}),

	readLogs: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
				tail: z.number().int().min(1).max(10000).default(100),
			}),
		)
		.query(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			assertWorkspaceResource(
				ctx.session.activeOrganizationId,
				deployment,
				"Deployment",
			);
			await authorizeDeploymentTarget(ctx, deployment, "read");

			if (!deployment.logPath) {
				return "";
			}

			const command = `tail -n ${input.tail} "${deployment.logPath}" 2>/dev/null || echo ""`;
			const serverId =
				deployment.serverId ||
				deployment.schedule?.serverId ||
				deployment.application?.serverId ||
				deployment.compose?.serverId;
			if (serverId) {
				const { stdout } = await execAsyncRemote(serverId, command);
				return stdout;
			}

			if (IS_CLOUD) {
				return "";
			}

			const { stdout } = await execAsync(command);
			return stdout;
		}),
});
