import type { CreateServiceOptions } from "dockerode";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db";
import {
	type createRollbackSchema,
	deployments as deploymentsSchema,
	rollbacks,
} from "../db/schema";
import { getRegistryTag } from "../utils/cluster/upload";
import {
	calculateResources,
	generateBindMounts,
	generateConfigContainer,
	generateVolumeMounts,
	prepareEnvironmentVariables,
} from "../utils/docker/utils";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import { type Application, findApplicationById } from "./application";
import { findDeploymentById } from "./deployment";
import type { Mount } from "./mount";
import { resolveServiceNetworks } from "./network";
import type { Port } from "./port";
import type { Project } from "./project";
import {
	findRegistryByIdWithCredentials,
	type Registry,
	safeDockerLoginCommand,
} from "./registry";

export const createRollback = async (
	input: z.infer<typeof createRollbackSchema>,
) => {
	const deployment = await findDeploymentById(input.deploymentId);
	if (
		!deployment.applicationId ||
		!deployment.organizationId ||
		!deployment.projectId ||
		!deployment.environmentId
	) {
		throw new Error("Deployment has no canonical application ownership");
	}
	return await db.transaction(async (tx) => {
		const rollback = await tx
			.insert(rollbacks)
			.values({
				deploymentId: input.deploymentId,
				image: input.image,
				organizationId: deployment.organizationId,
				projectId: deployment.projectId,
				environmentId: deployment.environmentId,
				fullContext: null,
			})
			.returning()
			.then((res) => res[0]);

		if (!rollback) {
			throw new Error("Failed to create rollback");
		}

		const tagImage = `${input.appName}:v${rollback.version}`;

		await tx
			.update(rollbacks)
			.set({
				image: tagImage,
			})
			.where(eq(rollbacks.rollbackId, rollback.rollbackId));

		// Update the deployment to reference this rollback
		await tx
			.update(deploymentsSchema)
			.set({
				rollbackId: rollback.rollbackId,
			})
			.where(eq(deploymentsSchema.deploymentId, rollback.deploymentId));

		const updatedRollback = await tx.query.rollbacks.findFirst({
			where: eq(rollbacks.rollbackId, rollback.rollbackId),
		});

		return updatedRollback;
	});
};

export const findRollbackById = async (rollbackId: string) => {
	const result = await db.query.rollbacks.findFirst({
		where: and(
			eq(rollbacks.rollbackId, rollbackId),
			isNull(rollbacks.deletedAt),
		),
		with: {
			deployment: true,
		},
	});

	if (!result) {
		throw new Error("Rollback not found");
	}

	return result;
};

const deleteRollbackImage = async (image: string, serverId?: string | null) => {
	const command = `docker image rm ${image} --force`;

	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const removeRollbackById = async (rollbackId: string) => {
	const rollback = await findRollbackById(rollbackId);

	if (!rollback) {
		throw new Error("Rollback not found");
	}

	if (rollback?.image) {
		try {
			const deployment = await findDeploymentById(rollback.deploymentId);

			if (!deployment?.applicationId) {
				throw new Error("Deployment not found");
			}

			const application = await findApplicationById(deployment.applicationId);
			await deleteRollbackImage(rollback.image, application.serverId);

		} catch (error) {
			console.error(error);
		}
	}
	await db
		.update(rollbacks)
		.set({ deletedAt: new Date() })
		.where(
			and(
				eq(rollbacks.rollbackId, rollbackId),
				isNull(rollbacks.deletedAt),
			),
		)
		.returning();

	return rollback;
};

export const rollback = async (rollbackId: string) => {
	const result = await findRollbackById(rollbackId);

	const deployment = await findDeploymentById(result.deploymentId);

	if (!deployment?.applicationId) {
		throw new Error("Deployment not found");
	}

	const application = await findApplicationById(deployment.applicationId);
	const rollbackRegistry = application.rollbackRegistryId
		? await findRegistryByIdWithCredentials(application.rollbackRegistryId)
		: null;
	const runtimeContext = { ...application, rollbackRegistry };
	await rollbackApplication(
		application.appName,
		result.image || "",
		application.serverId,
		runtimeContext,
	);
};

const dockerLoginForRegistry = async (
	registry: Registry,
	serverId?: string | null,
) => {
	const loginCommand = safeDockerLoginCommand(
		registry.registryUrl,
		registry.username,
		registry.password,
	);

	if (serverId) {
		await execAsyncRemote(serverId, loginCommand);
	} else {
		await execAsync(loginCommand);
	}
};

const rollbackApplication = async (
	appName: string,
	image: string,
	serverId?: string | null,
	fullContext?: Application & {
		environment: {
			project: Project;
		};
		mounts: Mount[];
		ports: Port[];
		rollbackRegistry?: Registry | null;
	},
) => {
	if (!fullContext) {
		throw new Error("Full context is required for rollback");
	}

	const rollbackRegistry = fullContext.rollbackRegistry ?? undefined;

	// Ensure Docker daemon is authenticated with the rollback registry
	// before updating the swarm service. The authconfig in CreateServiceOptions
	// alone is not sufficient — Docker Swarm also relies on the daemon's
	// cached credentials (~/.docker/config.json) to distribute auth to nodes.
	if (rollbackRegistry) {
		await dockerLoginForRegistry(rollbackRegistry, serverId);
	}

	const docker = await getRemoteDocker(serverId);

	const {
		env,
		mounts,
		cpuLimit,
		memoryLimit,
		memoryReservation,
		cpuReservation,
		command,
		ports,
	} = fullContext;

	const resources = calculateResources({
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
	});

	const volumesMount = generateVolumeMounts(mounts);

	const resolvedNetworks = await resolveServiceNetworks(
		fullContext as Parameters<typeof resolveServiceNetworks>[0],
	);

	const {
		HealthCheck,
		RestartPolicy,
		Placement,
		Labels,
		Mode,
		RollbackConfig,
		UpdateConfig,
		Ulimits,
	} = generateConfigContainer(
		fullContext as Parameters<typeof generateConfigContainer>[0],
	);

	const bindsMount = generateBindMounts(mounts);
	const envVariables = prepareEnvironmentVariables(
		env,
		fullContext.environment.project.env,
	);

	let rollbackImage = image;
	if (rollbackRegistry) {
		rollbackImage = getRegistryTag(rollbackRegistry, image);
	}

	const settings: CreateServiceOptions = {
		authconfig: {
			password: rollbackRegistry?.password || "",
			username: rollbackRegistry?.username || "",
			serveraddress: rollbackRegistry?.registryUrl || "",
		},
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck,
				Image: rollbackImage,
				Env: envVariables,
				Mounts: [...volumesMount, ...bindsMount],
				...(command
					? {
							Command: ["/bin/sh"],
							Args: ["-c", command],
						}
					: {}),
				...(Ulimits && { Ulimits }),
				Labels,
			},
			Networks: resolvedNetworks,
			RestartPolicy,
			Placement,
			Resources: {
				...resources,
			},
		},
		Mode,
		RollbackConfig,
		EndpointSpec: {
			Ports: ports.map((port) => ({
				PublishMode: port.publishMode,
				Protocol: port.protocol,
				TargetPort: port.targetPort,
				PublishedPort: port.publishedPort,
			})),
		},
		UpdateConfig,
	};

	try {
		const service = docker.getService(appName);
		const inspect = await service.inspect();

		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: inspect.Spec.TaskTemplate.ForceUpdate + 1,
			},
		});
	} catch (error) {
		console.error(error);
		await docker.createService(settings);
	}
};
