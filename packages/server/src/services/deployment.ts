import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type apiCreateDeployment,
	type apiCreateDeploymentBackup,
	type apiCreateDeploymentCompose,
	type apiCreateDeploymentPreview,
	type apiCreateDeploymentSchedule,
	type apiCreateDeploymentServer,
	type apiCreateDeploymentVolumeBackup,
	applications,
	compose,
	deployments,
	environments,
	projects,
} from "@dokploy/server/db/schema";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { format } from "date-fns";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import {
	type Application,
	findApplicationById,
	updateApplicationStatus,
} from "./application";
import { findBackupById } from "./backup";
import { type Compose, findComposeById, updateCompose } from "./compose";
import { createConfigurationSnapshot } from "./configuration-snapshots";
import { transitionDeployment } from "./delivery";
import {
	findPreviewDeploymentById,
	type PreviewDeployment,
	updatePreviewDeployment,
} from "./preview-deployment";
import { findScheduleById } from "./schedule";
import { findServerById, type Server } from "./server";
import {
	assertStateTransition,
	type DeploymentState,
	deploymentTransitions,
	isTerminalState,
	normalizeDeploymentState,
} from "./state-machines/delivery";
import { findVolumeBackupById } from "./volume-backups";

export type ServicePath = { href: string | null; label: string };

export async function resolveServicePath(
	orgId: string,
	data: Record<string, unknown>,
): Promise<ServicePath> {
	try {
		const applicationId = data?.applicationId as string | undefined;
		const composeId = data?.composeId as string | undefined;
		if (applicationId) {
			const app = await findApplicationById(applicationId);
			if (app.environment.project.organizationId !== orgId) {
				return { href: null, label: "Application" };
			}
			return {
				href: `/dashboard/project/${app.environment.project.projectId}/environment/${app.environment.environmentId}/services/application/${app.applicationId}`,
				label: "Application",
			};
		}
		if (composeId) {
			const comp = await findComposeById(composeId);
			if (comp.environment.project.organizationId !== orgId) {
				return { href: null, label: "Compose" };
			}
			return {
				href: `/dashboard/project/${comp.environment.project.projectId}/environment/${comp.environment.environmentId}/services/compose/${comp.composeId}`,
				label: "Compose",
			};
		}
	} catch {
		// not found or unauthorized
	}
	return { href: null, label: "—" };
}

export type Deployment = typeof deployments.$inferSelect;

type ApplicationDeployment = Awaited<ReturnType<typeof findApplicationById>>;
type ComposeDeployment = Awaited<ReturnType<typeof findComposeById>>;

export const publicRepositoryReference = (value?: string | null) => {
	if (!value) return value;
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return value;
	}
};

const applicationSourceBranch = (application: ApplicationDeployment) => {
	switch (application.sourceType) {
		case "github":
			return application.branch;
		case "gitlab":
			return application.gitlabBranch;
		case "bitbucket":
			return application.bitbucketBranch;
		case "gitea":
			return application.giteaBranch;
		case "git":
			return application.customGitBranch;
		default:
			return null;
	}
};

const canonicalApplicationDeployment = (
	application: ApplicationDeployment,
	trigger: NonNullable<Deployment["trigger"]>,
	sourceBranch = applicationSourceBranch(application),
) => ({
	organizationId: application.environment.project.organizationId,
	projectId: application.environment.project.projectId,
	environmentId: application.environment.environmentId,
	trigger,
	sourceProvider: application.sourceType,
	sourceBranch,
	sourceConfigSnapshot: {
		applicationId: application.applicationId,
		sourceType: application.sourceType,
		repository: publicRepositoryReference(
			application.repository ??
			application.gitlabRepository ??
			application.bitbucketRepository ??
			application.giteaRepository ??
			application.customGitUrl ??
			application.dockerImage,
		),
		owner:
			application.owner ??
			application.gitlabOwner ??
			application.bitbucketOwner ??
			application.giteaOwner,
	},
	buildConfigSnapshot: {
		buildType: application.buildType,
		buildPath:
			application.buildPath ??
			application.gitlabBuildPath ??
			application.bitbucketBuildPath ??
			application.giteaBuildPath ??
			application.customGitBuildPath ??
			application.dropBuildPath,
		dockerfile: application.dockerfile,
		publishDirectory: application.publishDirectory,
	},
	runtimeConfigSnapshot: {
		applicationId: application.applicationId,
		replicas: application.replicas,
		legacyEnvironment: true,
	},
});

const composeSourceBranch = (service: ComposeDeployment) => {
	switch (service.sourceType) {
		case "github":
			return service.branch;
		case "gitlab":
			return service.gitlabBranch;
		case "bitbucket":
			return service.bitbucketBranch;
		case "gitea":
			return service.giteaBranch;
		case "git":
			return service.customGitBranch;
		default:
			return null;
	}
};

const canonicalComposeDeployment = (
	service: ComposeDeployment,
	trigger: NonNullable<Deployment["trigger"]>,
) => ({
	organizationId: service.environment.project.organizationId,
	projectId: service.environment.project.projectId,
	environmentId: service.environment.environmentId,
	trigger,
	sourceProvider: service.sourceType,
	sourceBranch: composeSourceBranch(service),
	sourceConfigSnapshot: {
		composeId: service.composeId,
		sourceType: service.sourceType,
		repository: publicRepositoryReference(
			service.repository ??
			service.gitlabRepository ??
			service.bitbucketRepository ??
			service.giteaRepository ??
			service.customGitUrl,
		),
	},
	buildConfigSnapshot: { composeId: service.composeId },
	runtimeConfigSnapshot: {
		composeId: service.composeId,
		legacyEnvironment: true,
	},
});

const canonicalEnvironmentOwnership = async (environmentId?: string | null) => {
	if (!environmentId) return {};
	const environment = await db.query.environments.findFirst({
		where: eq(environments.environmentId, environmentId),
		columns: { environmentId: true, projectId: true, organizationId: true },
		with: { project: { columns: { organizationId: true } } },
	});
	if (!environment) return {};
	return {
		organizationId:
			environment.organizationId ?? environment.project.organizationId,
		projectId: environment.projectId,
		environmentId: environment.environmentId,
	};
};

type DeploymentInsert = typeof deployments.$inferInsert;

const snapshotRecord = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

const insertDeploymentWithConfigurationSnapshot = async (
	value: DeploymentInsert,
) =>
	db.transaction(async (transaction) => {
		let configurationSnapshotId = value.configurationSnapshotId;
		if (
			!configurationSnapshotId &&
			typeof value.organizationId === "string" &&
			typeof value.projectId === "string" &&
			typeof value.environmentId === "string"
		) {
			const service = value.applicationId
				? { type: "application", id: value.applicationId }
				: value.composeId
					? { type: "compose", id: value.composeId }
					: value.previewDeploymentId
						? { type: "preview", id: value.previewDeploymentId }
						: value.backupId
							? { type: "backup", id: value.backupId }
							: value.volumeBackupId
								? { type: "volume-backup", id: value.volumeBackupId }
								: value.scheduleId
									? { type: "schedule", id: value.scheduleId }
									: { type: "environment", id: value.environmentId };
			const snapshot = await createConfigurationSnapshot(
				{
					organizationId: value.organizationId,
					projectId: value.projectId,
					environmentId: value.environmentId,
					serviceType: service.type,
					serviceId: service.id,
					sourceConfig: snapshotRecord(value.sourceConfigSnapshot),
					buildConfig: snapshotRecord(value.buildConfigSnapshot),
					runtimeConfig: snapshotRecord(value.runtimeConfigSnapshot),
				},
				transaction,
			);
			configurationSnapshotId = snapshot.configurationSnapshotId;
		}

		return transaction
			.insert(deployments)
			.values({ ...value, configurationSnapshotId })
			.returning();
	});

export const findDeploymentById = async (deploymentId: string) => {
	const deployment = await db.query.deployments.findFirst({
		where: and(
			eq(deployments.deploymentId, deploymentId),
			isNull(deployments.deletedAt),
		),
		with: {
			application: {
				columns: {
					applicationId: true,
					appName: true,
					name: true,
					serverId: true,
				},
			},
			compose: {
				columns: { composeId: true, appName: true, name: true, serverId: true },
			},
			schedule: true,
		},
	});
	if (!deployment) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Deployment not found",
		});
	}
	return deployment;
};

export const beginDeploymentCancellation = async (input: {
	organizationId: string;
	applicationId?: string;
	composeId?: string;
}) => {
	const target = input.applicationId
		? eq(deployments.applicationId, input.applicationId)
		: input.composeId
			? eq(deployments.composeId, input.composeId)
			: null;
	if (!target) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "Service is required" });
	}

	return db.transaction(async (transaction) => {
		const serviceKey = input.applicationId
			? `application:${input.applicationId}`
			: `compose:${input.composeId}`;
		await transaction.execute(
			sql`select pg_advisory_xact_lock(hashtext(${`${input.organizationId}:cancel:${serviceKey}`}))`,
		);
		const [active] = await transaction
			.select()
			.from(deployments)
			.where(
				and(
					eq(deployments.organizationId, input.organizationId),
					target,
					isNull(deployments.deletedAt),
					inArray(deployments.status, [
						"queued",
						"preparing",
						"building",
						"deploying",
						"checking",
						"running",
					]),
				),
			)
			.orderBy(
				desc(deployments.desiredSequence),
				desc(deployments.createdAt),
				desc(deployments.deploymentId),
			)
			.limit(1)
			.for("update");
		if (!active?.status) return null;

		if (active.status === "queued") {
			const cancelled = await transitionDeployment(
				{
					organizationId: input.organizationId,
					deploymentId: active.deploymentId,
					expectedStatus: "queued",
					nextStatus: "cancelled",
				},
				transaction,
			);
			return { deployment: cancelled, canonicalCancellation: false };
		}

		if (
			["preparing", "building", "deploying", "checking"].includes(
				active.status,
			)
		) {
			const cancelling = await transitionDeployment(
				{
					organizationId: input.organizationId,
					deploymentId: active.deploymentId,
					expectedStatus: active.status as
						| "preparing"
						| "building"
						| "deploying"
						| "checking",
					nextStatus: "cancelling",
				},
				transaction,
			);
			return { deployment: cancelling, canonicalCancellation: true };
		}

		return { deployment: active, canonicalCancellation: false };
	});
};

export const findDeploymentByApplicationId = async (applicationId: string) => {
	const deployment = await db.query.deployments.findFirst({
		where: eq(deployments.applicationId, applicationId),
	});

	if (!deployment) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Deployment not found",
		});
	}
	return deployment;
};

export const createDeployment = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeployment>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	const application = await findApplicationById(deployment.applicationId);
	await removeLastTenDeployments(
		deployment.applicationId,
		"application",
		application.serverId,
	);
	try {
		const serverId = application.buildServerId || application.serverId;

		const { LOGS_PATH } = paths(!!serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${application.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(LOGS_PATH, application.appName, fileName);

		if (serverId) {
			const server = await findServerById(serverId);

			const command = `
				mkdir -p ${LOGS_PATH}/${application.appName};
            	echo "Initializing deployment" >> ${logFilePath};
			    echo "Building on ${serverId ? "Build Server" : "Dokploy Server"}" >> ${logFilePath};
			`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(path.join(LOGS_PATH, application.appName), {
				recursive: true,
			});
			await fsPromises.writeFile(logFilePath, "Initializing deployment\n");
		}

		const deploymentCreate = await insertDeploymentWithConfigurationSnapshot({
				...canonicalApplicationDeployment(application, "manual"),
				applicationId: deployment.applicationId,
				title: deployment.title || "Deployment",
				status: "running",
				logPath: logFilePath,
				description: deployment.description || "",
				startedAt: new Date().toISOString(),
				...(application.buildServerId && {
					buildServerId: application.buildServerId,
				}),
			});
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		await insertDeploymentWithConfigurationSnapshot({
				...canonicalApplicationDeployment(application, "manual"),
				applicationId: deployment.applicationId,
				title: deployment.title || "Deployment",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			});
		await updateApplicationStatus(application.applicationId, "error");
		console.log(error);
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the deployment",
		});
	}
};

export const createDeploymentPreview = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentPreview>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	const previewDeployment = await findPreviewDeploymentById(
		deployment.previewDeploymentId,
	);
	const previewApplication = await findApplicationById(
		previewDeployment.applicationId,
	);
	await removeLastTenDeployments(
		deployment.previewDeploymentId,
		"previewDeployment",
		previewDeployment?.application?.serverId,
	);
	try {
		const appName = `${previewDeployment.appName}`;
		const { LOGS_PATH } = paths(!!previewDeployment?.application?.serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(LOGS_PATH, appName, fileName);

		if (previewDeployment?.application?.serverId) {
			const server = await findServerById(
				previewDeployment?.application?.serverId,
			);

			const command = `
				mkdir -p ${LOGS_PATH}/${appName};
            	echo "Initializing deployment" >> ${logFilePath};
			`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(path.join(LOGS_PATH, appName), {
				recursive: true,
			});
			await fsPromises.writeFile(logFilePath, "Initializing deployment");
		}

		const deploymentCreate = await insertDeploymentWithConfigurationSnapshot({
				...canonicalApplicationDeployment(
					previewApplication,
					"git_pull_request",
					previewDeployment.branch,
				),
				title: deployment.title || "Deployment",
				status: "running",
				logPath: logFilePath,
				description: deployment.description || "",
				previewDeploymentId: deployment.previewDeploymentId,
				startedAt: new Date().toISOString(),
			});
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		await insertDeploymentWithConfigurationSnapshot({
				...canonicalApplicationDeployment(
					previewApplication,
					"git_pull_request",
					previewDeployment.branch,
				),
				previewDeploymentId: deployment.previewDeploymentId,
				title: deployment.title || "Deployment",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			});
		await updatePreviewDeployment(deployment.previewDeploymentId, {
			previewStatus: "error",
		});
		console.log(error);
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the deployment",
		});
	}
};

export const createDeploymentCompose = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentCompose>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	const compose = await findComposeById(deployment.composeId);
	await removeLastTenDeployments(
		deployment.composeId,
		"compose",
		compose.serverId,
	);
	try {
		const { LOGS_PATH } = paths(!!compose.serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${compose.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(LOGS_PATH, compose.appName, fileName);

		if (compose.serverId) {
			const server = await findServerById(compose.serverId);

			const command = `
mkdir -p ${LOGS_PATH}/${compose.appName};
echo "Initializing deployment\n" >> ${logFilePath};
`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(path.join(LOGS_PATH, compose.appName), {
				recursive: true,
			});
			await fsPromises.writeFile(logFilePath, "Initializing deployment\n");
		}

		const deploymentCreate = await insertDeploymentWithConfigurationSnapshot({
				...canonicalComposeDeployment(compose, "manual"),
				composeId: deployment.composeId,
				title: deployment.title || "Deployment",
				description: deployment.description || "",
				status: "running",
				logPath: logFilePath,
				startedAt: new Date().toISOString(),
			});
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		await insertDeploymentWithConfigurationSnapshot({
				...canonicalComposeDeployment(compose, "manual"),
				composeId: deployment.composeId,
				title: deployment.title || "Deployment",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			});
		await updateCompose(compose.composeId, {
			composeStatus: "error",
		});
		console.log(error);
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the deployment",
		});
	}
};

export const createDeploymentBackup = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentBackup>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	const backup = await findBackupById(deployment.backupId);
	const backedUpService =
		backup.postgres ??
		backup.mariadb ??
		backup.mysql ??
		backup.mongo ??
		backup.libsql ??
		backup.compose;
	const canonicalBackupDeployment = {
		...(await canonicalEnvironmentOwnership(backedUpService?.environmentId)),
		trigger: "schedule" as const,
		sourceConfigSnapshot: { backupId: backup.backupId },
		buildConfigSnapshot: { operation: "backup" },
		runtimeConfigSnapshot: { backupId: backup.backupId },
	};

	let serverId: string | null | undefined;
	if (backup.backupType === "database") {
		serverId =
			backup.postgres?.serverId ||
			backup.mariadb?.serverId ||
			backup.mysql?.serverId ||
			backup.mongo?.serverId;
	} else if (backup.backupType === "compose") {
		serverId = backup.compose?.serverId;
	}
	await removeLastTenDeployments(deployment.backupId, "backup", serverId);
	try {
		const { LOGS_PATH } = paths(!!serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${backup.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(LOGS_PATH, backup.appName, fileName);

		if (serverId) {
			const server = await findServerById(serverId);

			const command = `
mkdir -p ${LOGS_PATH}/${backup.appName};
echo "Initializing backup\n" >> ${logFilePath};
`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(path.join(LOGS_PATH, backup.appName), {
				recursive: true,
			});
			await fsPromises.writeFile(logFilePath, "Initializing backup\n");
		}

		const deploymentCreate = await insertDeploymentWithConfigurationSnapshot({
				...canonicalBackupDeployment,
				backupId: deployment.backupId,
				title: deployment.title || "Backup",
				description: deployment.description || "",
				status: "running",
				logPath: logFilePath,
				startedAt: new Date().toISOString(),
			});
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the backup",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		await insertDeploymentWithConfigurationSnapshot({
				...canonicalBackupDeployment,
				backupId: deployment.backupId,
				title: deployment.title || "Backup",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			});
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the backup",
		});
	}
};

export const createDeploymentSchedule = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentSchedule>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	const schedule = await findScheduleById(deployment.scheduleId);
	const scheduleApplication = schedule.application
		? await findApplicationById(schedule.application.applicationId)
		: null;
	const scheduleCompose = schedule.compose
		? await findComposeById(schedule.compose.composeId)
		: null;
	const canonicalScheduleDeployment = scheduleApplication
		? canonicalApplicationDeployment(
				scheduleApplication,
				"schedule",
			)
		: scheduleCompose
			? canonicalComposeDeployment(scheduleCompose, "schedule")
			: {
					organizationId:
						schedule.organizationId ?? schedule.server?.organizationId ?? null,
					trigger: "schedule" as const,
					sourceConfigSnapshot: { scheduleId: schedule.scheduleId },
					buildConfigSnapshot: { scheduleId: schedule.scheduleId },
					runtimeConfigSnapshot: { scheduleId: schedule.scheduleId },
				};

	const serverId =
		schedule.application?.serverId ||
		schedule.compose?.serverId ||
		schedule.server?.serverId;
	await removeLastTenDeployments(deployment.scheduleId, "schedule", serverId);
	try {
		const { SCHEDULES_PATH } = paths(!!serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${schedule.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(SCHEDULES_PATH, schedule.appName, fileName);

		if (serverId) {
			const server = await findServerById(serverId);

			const command = `
				mkdir -p ${SCHEDULES_PATH}/${schedule.appName};
            	echo "Initializing schedule" >> ${logFilePath};
			`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(path.join(SCHEDULES_PATH, schedule.appName), {
				recursive: true,
			});
			await fsPromises.writeFile(logFilePath, "Initializing schedule\n");
		}

		const deploymentCreate = await insertDeploymentWithConfigurationSnapshot({
				...canonicalScheduleDeployment,
				scheduleId: deployment.scheduleId,
				title: deployment.title || "Deployment",
				status: "running",
				logPath: logFilePath,
				description: deployment.description || "",
				startedAt: new Date().toISOString(),
			});
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		console.log(error);
		await insertDeploymentWithConfigurationSnapshot({
				...canonicalScheduleDeployment,
				scheduleId: deployment.scheduleId,
				title: deployment.title || "Deployment",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			});

		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the deployment",
		});
	}
};

export const createDeploymentVolumeBackup = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentVolumeBackup>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	const volumeBackup = await findVolumeBackupById(deployment.volumeBackupId);
	const volumeService = volumeBackup.application ?? volumeBackup.compose;
	const canonicalVolumeBackupDeployment = {
		...(await canonicalEnvironmentOwnership(
			volumeService?.environment.environmentId,
		)),
		trigger: "schedule" as const,
		sourceConfigSnapshot: { volumeBackupId: volumeBackup.volumeBackupId },
		buildConfigSnapshot: { operation: "volume-backup" },
		runtimeConfigSnapshot: { volumeBackupId: volumeBackup.volumeBackupId },
	};

	const serverId =
		volumeBackup.application?.serverId || volumeBackup.compose?.serverId;
	await removeLastTenDeployments(
		deployment.volumeBackupId,
		"volumeBackup",
		serverId,
	);
	try {
		const { VOLUME_BACKUPS_PATH } = paths(!!serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${volumeBackup.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(
			VOLUME_BACKUPS_PATH,
			volumeBackup.appName,
			fileName,
		);

		if (serverId) {
			const server = await findServerById(serverId);

			const command = `
				mkdir -p ${VOLUME_BACKUPS_PATH}/${volumeBackup.appName};
            	echo "Initializing volume backup" >> ${logFilePath};
			`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(
				path.join(VOLUME_BACKUPS_PATH, volumeBackup.appName),
				{
					recursive: true,
				},
			);
			await fsPromises.writeFile(logFilePath, "Initializing volume backup\n");
		}

		const deploymentCreate = await insertDeploymentWithConfigurationSnapshot({
				...canonicalVolumeBackupDeployment,
				volumeBackupId: deployment.volumeBackupId,
				title: deployment.title || "Deployment",
				status: "running",
				logPath: logFilePath,
				description: deployment.description || "",
				startedAt: new Date().toISOString(),
			});
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		console.log(error);
		await insertDeploymentWithConfigurationSnapshot({
				...canonicalVolumeBackupDeployment,
				volumeBackupId: deployment.volumeBackupId,
				title: deployment.title || "Deployment",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			});

		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the deployment",
		});
	}
};

export const removeDeployment = async (
	deploymentId: string,
	organizationId?: string,
) => {
	const conditions = [
		eq(deployments.deploymentId, deploymentId),
		isNull(deployments.deletedAt),
	];
	if (organizationId) {
		conditions.push(eq(deployments.organizationId, organizationId));
	}
	return db
		.update(deployments)
		.set({ deletedAt: new Date() })
		.where(and(...conditions))
		.returning()
		.then((result) => result[0] ?? null);
};

export const removeDeploymentsByApplicationId = async (
	applicationId: string,
) => {
	await db
		.update(deployments)
		.set({ deletedAt: new Date() })
		.where(
			and(
				eq(deployments.applicationId, applicationId),
				isNull(deployments.deletedAt),
			),
		)
		.returning();
};

export const removeDeployments = async (application: Application) => {
	await removeDeploymentsByApplicationId(application.applicationId);
};

const removeLastTenDeployments = async (
	_id: string,
	_type:
		| "application"
		| "compose"
		| "server"
		| "schedule"
		| "previewDeployment"
		| "backup"
		| "volumeBackup",
	_serverId?: string | null,
) => {
	// Canonical deployment history and logs are retained. Cleanup is performed
	// only by an explicit, policy-aware retention job introduced in Phase 8.
};

export const removeDeploymentsByPreviewDeploymentId = async (
	previewDeployment: PreviewDeployment,
	_serverId: string | null,
) => {
	await db
		.update(deployments)
		.set({ deletedAt: new Date() })
		.where(
			and(
				eq(
					deployments.previewDeploymentId,
					previewDeployment.previewDeploymentId,
				),
				isNull(deployments.deletedAt),
			),
		)
		.returning();
};

export const removeDeploymentsByComposeId = async (compose: Compose) => {
	await db
		.update(deployments)
		.set({ deletedAt: new Date() })
		.where(
			and(
				eq(deployments.composeId, compose.composeId),
				isNull(deployments.deletedAt),
			),
		)
		.returning();
};

export const findAllDeploymentsByApplicationId = async (
	applicationId: string,
) => {
	const deploymentsList = await db.query.deployments.findMany({
		where: and(
			eq(deployments.applicationId, applicationId),
			isNull(deployments.deletedAt),
		),
		orderBy: desc(deployments.createdAt),
	});
	return deploymentsList;
};

export const findAllDeploymentsByComposeId = async (composeId: string) => {
	const deploymentsList = await db.query.deployments.findMany({
		where: and(
			eq(deployments.composeId, composeId),
			isNull(deployments.deletedAt),
		),
		orderBy: desc(deployments.createdAt),
	});
	return deploymentsList;
};

const centralizedDeploymentsWith = {
	application: {
		columns: { applicationId: true, name: true, appName: true },
		with: {
			environment: {
				columns: { environmentId: true, name: true },
				with: {
					project: {
						columns: { projectId: true, name: true },
					},
				},
			},
			server: {
				columns: { serverId: true, name: true, serverType: true },
			},
			buildServer: {
				columns: { serverId: true, name: true, serverType: true },
			},
		},
	},
	compose: {
		columns: { composeId: true, name: true, appName: true },
		with: {
			environment: {
				columns: { environmentId: true, name: true },
				with: {
					project: {
						columns: { projectId: true, name: true },
					},
				},
			},
			server: {
				columns: { serverId: true, name: true, serverType: true },
			},
		},
	},
	server: {
		columns: { serverId: true, name: true, serverType: true },
	},
	buildServer: {
		columns: { serverId: true, name: true, serverType: true },
	},
} as const;

async function getApplicationIdsInOrg(
	orgId: string,
	accessedServices: string[] | null,
): Promise<string[]> {
	const rows = await db
		.select({ applicationId: applications.applicationId })
		.from(applications)
		.innerJoin(
			environments,
			eq(applications.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(
			accessedServices !== null
				? and(
						eq(projects.organizationId, orgId),
						inArray(applications.applicationId, accessedServices),
					)
				: eq(projects.organizationId, orgId),
		);
	return rows.map((r) => r.applicationId);
}

async function getComposeIdsInOrg(
	orgId: string,
	accessedServices: string[] | null,
): Promise<string[]> {
	const rows = await db
		.select({ composeId: compose.composeId })
		.from(compose)
		.innerJoin(
			environments,
			eq(compose.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(
			accessedServices !== null
				? and(
						eq(projects.organizationId, orgId),
						inArray(compose.composeId, accessedServices),
					)
				: eq(projects.organizationId, orgId),
		);
	return rows.map((r) => r.composeId);
}

/**
 * All deployments for applications and compose in the org.
 * Pass accessedServices for members (only those services), null for owner/admin.
 */
export const findAllDeploymentsCentralized = async (
	orgId: string,
	accessedServices: string[] | null,
) => {
	if (accessedServices === null) {
		return db.query.deployments.findMany({
			where: and(
				eq(deployments.organizationId, orgId),
				isNull(deployments.deletedAt),
			),
			orderBy: desc(deployments.createdAt),
			with: centralizedDeploymentsWith,
		});
	}
	if (accessedServices !== null && accessedServices.length === 0) {
		return [];
	}

	const [appIds, compIds] = await Promise.all([
		getApplicationIdsInOrg(orgId, accessedServices),
		getComposeIdsInOrg(orgId, accessedServices),
	]);

	if (appIds.length === 0 && compIds.length === 0) {
		return [];
	}

	const conditions = [
		...(appIds.length > 0 ? [inArray(deployments.applicationId, appIds)] : []),
		...(compIds.length > 0 ? [inArray(deployments.composeId, compIds)] : []),
	];
	const serviceClause =
		conditions.length === 0
			? sql`1 = 0`
			: conditions.length === 1
				? conditions[0]
				: or(...conditions);

	return db.query.deployments.findMany({
		where: and(
			eq(deployments.organizationId, orgId),
			isNull(deployments.deletedAt),
			serviceClause,
		),
		orderBy: desc(deployments.createdAt),
		with: centralizedDeploymentsWith,
	});
};

export const updateDeployment = async (
	deploymentId: string,
	deploymentData: Partial<Deployment>,
) => {
	if (
		deploymentData.organizationId !== undefined ||
		deploymentData.projectId !== undefined ||
		deploymentData.environmentId !== undefined ||
		deploymentData.applicationId !== undefined ||
		deploymentData.composeId !== undefined ||
		deploymentData.previewDeploymentId !== undefined ||
		deploymentData.configurationSnapshotId !== undefined ||
		deploymentData.sourceConfigSnapshot !== undefined ||
		deploymentData.buildConfigSnapshot !== undefined ||
		deploymentData.runtimeConfigSnapshot !== undefined
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Deployment provenance and configuration are immutable",
		});
	}
	if (deploymentData.status !== undefined) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Deployment status must use the state transition service",
		});
	}
	const current = await db.query.deployments.findFirst({
		where: eq(deployments.deploymentId, deploymentId),
	});
	if (!current) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Deployment not found" });
	}
	if (
		current.status &&
		isTerminalState(
			deploymentTransitions,
			normalizeDeploymentState(current.status) as DeploymentState,
		)
	) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Completed deployments are immutable",
		});
	}
	const application = await db
		.update(deployments)
		.set({
			...deploymentData,
		})
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				current.status
					? eq(deployments.status, current.status)
					: sql`${deployments.status} IS NULL`,
			),
		)
		.returning();
	if (application.length === 0) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Deployment changed while it was being updated",
		});
	}

	return application;
};

export const updateDeploymentStatus = async (
	deploymentId: string,
	deploymentStatus: Deployment["status"],
) => {
	if (!deploymentStatus) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Deployment status is required",
		});
	}
	const current = await db.query.deployments.findFirst({
		where: eq(deployments.deploymentId, deploymentId),
	});
	if (!current) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Deployment not found" });
	}
	if (!current.status) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Deployment has no valid current state",
		});
	}
	const currentCanonical = normalizeDeploymentState(current.status);
	const nextCanonical = normalizeDeploymentState(deploymentStatus);
	if (currentCanonical === nextCanonical) return [current];
	if (isTerminalState(deploymentTransitions, currentCanonical)) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Completed deployments are immutable",
		});
	}
	const legacyTransition =
		current.status === "running" &&
		["done", "error", "cancelled"].includes(deploymentStatus);
	if (!legacyTransition) {
		assertStateTransition(
			"deployment",
			deploymentTransitions,
			currentCanonical,
			nextCanonical,
		);
	}
	const application = await db
		.update(deployments)
		.set({
			status: deploymentStatus,
			finishedAt:
				deploymentStatus === "done" ||
				deploymentStatus === "error" ||
				deploymentStatus === "ready" ||
				deploymentStatus === "failed" ||
				deploymentStatus === "cancelled"
					? new Date().toISOString()
					: null,
		})
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				eq(deployments.status, current.status),
			),
		)
		.returning();
	if (application.length === 0) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Deployment changed while its state transition was in progress",
		});
	}

	return application;
};

export const createServerDeployment = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentServer>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	try {
		const { LOGS_PATH } = paths();

		const server = await findServerById(deployment.serverId);
		await removeLastFiveDeployments(deployment.serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${server.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(LOGS_PATH, server.appName, fileName);
		await fsPromises.mkdir(path.join(LOGS_PATH, server.appName), {
			recursive: true,
		});
		await fsPromises.writeFile(logFilePath, "Initializing Setup Server");
		const deploymentCreate = await insertDeploymentWithConfigurationSnapshot({
				organizationId: server.organizationId,
				trigger: "manual",
				sourceConfigSnapshot: { serverId: server.serverId },
				buildConfigSnapshot: { operation: "server-setup" },
				runtimeConfigSnapshot: { serverId: server.serverId },
				serverId: server.serverId,
				title: deployment.title || "Deployment",
				description: deployment.description || "",
				status: "running",
				logPath: logFilePath,
			});
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Error creating the deployment";
		throw new TRPCError({
			code: "BAD_REQUEST",
			message,
		});
	}
};

export const removeLastFiveDeployments = async (serverId: string) => {
	void serverId;
	// Canonical server deployment records and logs are retained until the
	// policy-aware retention job is introduced.
};

export const removeDeploymentsByServerId = async (server: Server) => {
	await db
		.update(deployments)
		.set({ deletedAt: new Date() })
		.where(
			and(
				eq(deployments.serverId, server.serverId),
				isNull(deployments.deletedAt),
			),
		)
		.returning();
};

export const findAllDeploymentsByServerId = async (serverId: string) => {
	const deploymentsList = await db.query.deployments.findMany({
		where: and(
			eq(deployments.serverId, serverId),
			isNull(deployments.deletedAt),
		),
		orderBy: desc(deployments.createdAt),
	});
	return deploymentsList;
};

export const clearOldDeployments = async (
	appName: string,
	serverId: string | null,
) => {
	const { LOGS_PATH } = paths(!!serverId);
	const folder = path.join(LOGS_PATH, appName);
	const command = `
		rm -rf ${folder};
	`;
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};
