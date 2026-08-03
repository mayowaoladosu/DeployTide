import { createHash, X509Certificate } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	buildPools,
	capacityLeases,
	controllerCertificates,
	infrastructureIncidents,
	infrastructureProviders,
	legacyInfrastructureInputs,
	operatorJobAttempts,
	regions,
	runtimeClusters,
	runtimeTargets,
	server,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
	type AdapterExecutionContext,
	assertOperatorSecretId,
	hasOperatorSecretReference,
	InfrastructureAdapterRegistry,
	LayerRailComputeInfrastructureProvider,
	LocalDockerInfrastructureProvider,
	resolveControllerCertificateEnrollment,
} from "../infrastructure";
import { encryptValue } from "../lib/encryption";
import { type OperatorAuditInput, recordOperatorAudit } from "./operator-audit";
import type { DatabaseTransaction } from "./tenancy";

const adapterTypePattern = /^[a-z][a-z0-9-]{1,63}$/;
const regionCodePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const identityPattern = /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,191}$/;

const adapterContext = (input: {
	providerId: string;
	regionCode: string;
	correlationId: string;
	fencingToken?: number;
}): AdapterExecutionContext => ({
	providerId: input.providerId,
	regionCode: input.regionCode,
	correlationId: input.correlationId,
	fencingToken: input.fencingToken ?? 1,
});

export const createInfrastructureAdapterRegistry = () => {
	const registry = new InfrastructureAdapterRegistry();
	if (process.env.NODE_ENV !== "production") {
		registry.register(
			"infrastructure",
			new LocalDockerInfrastructureProvider(),
		);
	}
	return registry;
};

const resolveProviderAdapter = (
	provider: typeof infrastructureProviders.$inferSelect,
	registry = createInfrastructureAdapterRegistry(),
) => {
	if (provider.adapterType === "layerrail-compute") {
		if (!provider.secretReference) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message:
					"LayerRail Compute provider requires an operator secret reference",
			});
		}
		registry.replace(
			"infrastructure",
			new LayerRailComputeInfrastructureProvider({
				endpoint: provider.endpointReference,
				secretId: provider.secretReference,
			}),
		);
	}
	return registry.resolve("infrastructure", provider.adapterType);
};

export const createInfrastructureProvider = async (
	input: {
		name: string;
		adapterType: string;
		endpointReference: string;
		secretId?: string | null;
		capabilities: string[];
		version: string;
	},
	audit?: OperatorAuditInput,
) => {
	if (!input.name.trim() || !adapterTypePattern.test(input.adapterType)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Infrastructure provider identity is invalid",
		});
	}
	if (
		!(["layerrail-compute", "local-docker"] as string[]).includes(
			input.adapterType,
		)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Infrastructure provider adapter is not registered",
		});
	}
	if (
		input.adapterType === "local-docker" &&
		process.env.NODE_ENV === "production"
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The local adapter is development-only",
		});
	}
	if (input.adapterType === "layerrail-compute" && !input.secretId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "LayerRail Compute requires a secret ID",
		});
	}
	if (input.secretId) {
		try {
			assertOperatorSecretId(input.secretId);
		} catch {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Operator secret ID is invalid",
			});
		}
	}
	if (input.adapterType === "layerrail-compute" && input.secretId) {
		try {
			new LayerRailComputeInfrastructureProvider({
				endpoint: input.endpointReference,
				secretId: input.secretId,
			});
		} catch {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "LayerRail Compute endpoint is not allowed",
			});
		}
	}
	return db.transaction(async (transaction) => {
		const [provider] = await transaction
			.insert(infrastructureProviders)
			.values({
				name: input.name.trim(),
				adapterType: input.adapterType,
				endpointReference: input.endpointReference,
				secretReference: input.secretId,
				capabilities: [...new Set(input.capabilities)].sort(),
				version: input.version,
			})
			.returning();
		if (!provider)
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Infrastructure provider was not created",
			});
		if (audit) {
			await recordOperatorAudit(
				{
					...audit,
					resourceId: provider.infrastructureProviderId,
					metadata: { adapterType: provider.adapterType },
				},
				transaction,
			);
		}
		return {
			infrastructureProviderId: provider.infrastructureProviderId,
			name: provider.name,
			adapterType: provider.adapterType,
			status: provider.status,
			health: provider.health,
			version: provider.version,
			hasSecretReference: hasOperatorSecretReference(provider.secretReference),
			createdAt: provider.createdAt,
		};
	});
};

export const probeInfrastructureProvider = async (
	infrastructureProviderId: string,
	registry?: InfrastructureAdapterRegistry,
	audit?: OperatorAuditInput,
) => {
	const provider = await db.query.infrastructureProviders.findFirst({
		where: and(
			eq(
				infrastructureProviders.infrastructureProviderId,
				infrastructureProviderId,
			),
			isNull(infrastructureProviders.deletedAt),
		),
	});
	if (!provider)
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Infrastructure provider not found",
		});
	try {
		const result = await resolveProviderAdapter(provider, registry).probe(
			adapterContext({
				providerId: provider.infrastructureProviderId,
				regionCode: provider.enabledRegionCodes[0] ?? "global",
				correlationId: `probe:${provider.infrastructureProviderId}:${Date.now()}`,
			}),
		);
		return db.transaction(async (transaction) => {
			const [updated] = await transaction
				.update(infrastructureProviders)
				.set({
					health: result.health,
					status: result.health === "healthy" ? "ready" : "degraded",
					version: result.version,
					capabilities: result.capabilities,
					healthDetails: result.details,
					lastHealthAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					eq(
						infrastructureProviders.infrastructureProviderId,
						provider.infrastructureProviderId,
					),
				)
				.returning();
			if (!updated)
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Infrastructure provider not found",
				});
			if (audit) await recordOperatorAudit(audit, transaction);
			return {
				infrastructureProviderId: updated.infrastructureProviderId,
				name: updated.name,
				adapterType: updated.adapterType,
				health: updated.health,
				status: updated.status,
				version: updated.version,
				capabilities: updated.capabilities,
				lastHealthAt: updated.lastHealthAt,
			};
		});
	} catch (error) {
		await db.transaction(async (transaction) => {
			await transaction
				.update(infrastructureProviders)
				.set({
					health: "unavailable",
					status: "unavailable",
					healthDetails: { message: "Provider probe failed" },
					lastHealthAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					eq(
						infrastructureProviders.infrastructureProviderId,
						provider.infrastructureProviderId,
					),
				);
			if (audit) {
				await recordOperatorAudit(
					{ ...audit, metadata: { status: "unavailable" } },
					transaction,
				);
			}
		});
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Infrastructure provider probe failed",
		});
	}
};

export const rotateInfrastructureProviderSecret = async (
	input: { infrastructureProviderId: string; secretId: string },
	audit?: OperatorAuditInput,
) => {
	try {
		assertOperatorSecretId(input.secretId);
	} catch {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Operator secret ID is invalid",
		});
	}
	return db.transaction(async (transaction) => {
		const [provider] = await transaction
			.update(infrastructureProviders)
			.set({
				secretReference: input.secretId,
				health: "unknown",
				status: "provisioning",
				lastHealthAt: null,
				healthDetails: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(
						infrastructureProviders.infrastructureProviderId,
						input.infrastructureProviderId,
					),
					eq(infrastructureProviders.adapterType, "layerrail-compute"),
					isNull(infrastructureProviders.deletedAt),
				),
			)
			.returning();
		if (!provider) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Infrastructure provider not found",
			});
		}
		if (audit) await recordOperatorAudit(audit, transaction);
		return {
			infrastructureProviderId: provider.infrastructureProviderId,
			adapterType: provider.adapterType,
			health: provider.health,
			status: provider.status,
			hasSecretReference: true,
		};
	});
};

export const createRegion = async (
	input: {
		infrastructureProviderId: string;
		code: string;
		name: string;
		providerRegionReference: string;
		buildAvailable: boolean;
		runtimeAvailable: boolean;
		residencyMetadata?: Record<string, string | boolean>;
		routingWeight?: number;
		costWeight?: number;
	},
	audit?: OperatorAuditInput,
) => {
	if (!regionCodePattern.test(input.code) || !input.name.trim()) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Region identity is invalid",
		});
	}
	const provider = await db.query.infrastructureProviders.findFirst({
		where: and(
			eq(
				infrastructureProviders.infrastructureProviderId,
				input.infrastructureProviderId,
			),
			isNull(infrastructureProviders.deletedAt),
		),
		columns: {
			infrastructureProviderId: true,
			enabledRegionCodes: true,
			health: true,
			status: true,
			lastHealthAt: true,
		},
	});
	if (!provider)
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Infrastructure provider not found",
		});
	if (
		provider.health !== "healthy" ||
		provider.status !== "ready" ||
		!provider.lastHealthAt ||
		provider.lastHealthAt < new Date(Date.now() - 60_000)
	) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Infrastructure provider needs a fresh healthy probe",
		});
	}
	return db.transaction(async (transaction) => {
		const [region] = await transaction
			.insert(regions)
			.values({
				...input,
				name: input.name.trim(),
				status: "ready",
			})
			.returning();
		if (!region)
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Region was not created",
			});
		await transaction
			.update(infrastructureProviders)
			.set({
				enabledRegionCodes: [
					...new Set([...provider.enabledRegionCodes, input.code]),
				].sort(),
				updatedAt: new Date(),
			})
			.where(
				eq(
					infrastructureProviders.infrastructureProviderId,
					input.infrastructureProviderId,
				),
			);
		if (audit) {
			await recordOperatorAudit(
				{
					...audit,
					resourceId: region.regionId,
					metadata: { code: region.code },
				},
				transaction,
			);
		}
		return region;
	});
};

export const createBuildPool = async (
	input: {
		infrastructureProviderId: string;
		regionId: string;
		name: string;
		adapterType: string;
		architecture: "amd64" | "arm64";
		workerClass: string;
		minCapacity: number;
		maxCapacity: number;
		totalCapacity: number;
		cacheNamespace: string;
		endpointReference?: string | null;
		autoscalingPolicy?: Record<string, unknown>;
		version: string;
	},
	audit?: OperatorAuditInput,
) => {
	if (
		!Number.isInteger(input.minCapacity) ||
		!Number.isInteger(input.maxCapacity) ||
		!Number.isInteger(input.totalCapacity) ||
		input.minCapacity < 0 ||
		input.maxCapacity <= 0 ||
		input.totalCapacity < input.minCapacity ||
		input.totalCapacity > input.maxCapacity
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Build pool capacity bounds are invalid",
		});
	}
	return db.transaction(async (transaction) => {
		const region = await transaction.query.regions.findFirst({
			where: and(
				eq(regions.regionId, input.regionId),
				eq(regions.infrastructureProviderId, input.infrastructureProviderId),
				eq(regions.buildAvailable, true),
				eq(regions.status, "ready"),
				isNull(regions.deletedAt),
			),
			columns: { regionId: true },
		});
		if (!region)
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Build pool region is unavailable",
			});
		const [pool] = await transaction
			.insert(buildPools)
			.values({
				...input,
				rootless: true,
				autoscalingPolicy: input.autoscalingPolicy ?? {},
			})
			.returning();
		if (!pool)
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Build pool was not created",
			});
		if (audit) {
			await recordOperatorAudit(
				{
					...audit,
					resourceId: pool.buildPoolId,
					metadata: {
						adapterType: pool.adapterType,
						architecture: pool.architecture,
					},
				},
				transaction,
			);
		}
		return pool;
	});
};

export const recordBuildPoolProbe = async (input: {
	buildPoolId: string;
	health: "healthy" | "degraded" | "unavailable";
	version: string;
	now?: Date;
}) => {
	const now = input.now ?? new Date();
	const [pool] = await db
		.update(buildPools)
		.set({
			health: input.health,
			version: input.version,
			lastHealthAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(buildPools.buildPoolId, input.buildPoolId),
				isNull(buildPools.deletedAt),
			),
		)
		.returning();
	if (!pool) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Build pool not found" });
	}
	return pool;
};

export const createRuntimeCluster = async (
	input: {
		infrastructureProviderId: string;
		regionId: string;
		name: string;
		runtimeAdapter: string;
		endpointReference: string;
		certificateEnrollmentId: string;
		controllerIdentity: string;
		totalCpuMillis: number;
		totalMemoryMb: number;
		controllerVersion: string;
		version: string;
	},
	audit?: OperatorAuditInput,
) => {
	if (!identityPattern.test(input.controllerIdentity)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Controller identity is invalid",
		});
	}
	return db.transaction(async (transaction) => {
		const region = await transaction.query.regions.findFirst({
			where: and(
				eq(regions.regionId, input.regionId),
				eq(regions.infrastructureProviderId, input.infrastructureProviderId),
				eq(regions.runtimeAvailable, true),
				isNull(regions.deletedAt),
			),
			columns: { regionId: true },
		});
		if (!region)
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Runtime cluster region is unavailable",
			});
		const { certificateEnrollmentId, ...clusterValues } = input;
		const [cluster] = await transaction
			.insert(runtimeClusters)
			.values({
				...clusterValues,
				certificateReference: `operator-enrollment://${certificateEnrollmentId}`,
			})
			.returning();
		if (!cluster)
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Runtime cluster was not created",
			});
		if (audit) {
			await recordOperatorAudit(
				{
					...audit,
					resourceId: cluster.runtimeClusterId,
					metadata: { runtimeAdapter: cluster.runtimeAdapter },
				},
				transaction,
			);
		}
		return cluster;
	});
};

export const createRuntimeTarget = async (
	input: {
		runtimeClusterId: string;
		providerTargetReference: string;
		architecture: "amd64" | "arm64";
		totalCpuMillis: number;
		totalMemoryMb: number;
		placementLabels?: Record<string, string>;
		version: string;
	},
	audit?: OperatorAuditInput,
) =>
	db.transaction(async (transaction) => {
		const cluster = await transaction.query.runtimeClusters.findFirst({
			where: and(
				eq(runtimeClusters.runtimeClusterId, input.runtimeClusterId),
				isNull(runtimeClusters.deletedAt),
			),
			columns: { runtimeClusterId: true },
		});
		if (!cluster)
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Runtime cluster not found",
			});
		const [target] = await transaction
			.insert(runtimeTargets)
			.values({
				...input,
				placementLabels: input.placementLabels ?? {},
			})
			.returning();
		if (!target)
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Runtime target was not created",
			});
		if (audit) {
			await recordOperatorAudit(
				{
					...audit,
					resourceId: target.runtimeTargetId,
					metadata: { architecture: target.architecture },
				},
				transaction,
			);
		}
		return target;
	});

export const bootstrapLocalOperatorTopology = async (
	input: {
		name: string;
		regions: [
			{ code: string; name: string; residency: string },
			{ code: string; name: string; residency: string },
		];
		controllerCertificateEnrollmentId: string;
		controllerVersion: string;
		actorId: string;
	},
	audit?: OperatorAuditInput,
) => {
	if (process.env.NODE_ENV === "production") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The local infrastructure adapter is development-only",
		});
	}
	if (
		!input.name.trim() ||
		input.regions.some((region) => !regionCodePattern.test(region.code)) ||
		input.regions[0].code === input.regions[1].code
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Local operator topology requires two distinct valid regions",
		});
	}
	const existing = await db.query.infrastructureProviders.findFirst({
		where: and(
			eq(infrastructureProviders.name, input.name.trim()),
			isNull(infrastructureProviders.deletedAt),
		),
		columns: { infrastructureProviderId: true },
	});
	if (existing) {
		if (audit) {
			await recordOperatorAudit({
				...audit,
				resourceId: existing.infrastructureProviderId,
				metadata: { adapterType: "local-docker", regionCount: 2 },
			});
		}
		return listOperatorInfrastructureOverview();
	}

	const providerId = nanoid();
	const adapter = new LocalDockerInfrastructureProvider();
	const probe = await adapter.probe(
		adapterContext({
			providerId,
			regionCode: input.regions[0].code,
			correlationId: `bootstrap:${providerId}:probe`,
		}),
	);
	if (probe.health !== "healthy") {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Local Docker provider is not healthy",
		});
	}
	const architecture =
		probe.details?.architecture === "arm64" ? "arm64" : "amd64";
	const cpuMillis = Math.max(2_000, Number(probe.details?.cpus ?? 2) * 1_000);
	const memoryMb = Math.max(
		1_024,
		Math.floor(
			Number(probe.details?.memoryBytes ?? 2 * 1024 ** 3) / 1024 / 1024,
		),
	);
	const buildCapacity = await adapter.execute(
		adapterContext({
			providerId,
			regionCode: input.regions[0].code,
			correlationId: `bootstrap:${providerId}:build`,
		}),
		{
			kind: "capacity.provision",
			requestId: `bootstrap-build-${providerId}`,
			capacityKind: "build",
			architecture,
			cpuMillis,
			memoryMb,
			cloudInit: "#cloud-config\nwrite_files: []\n",
			labels: { plane: "build", owner: "deploytide" },
		},
	);
	if (buildCapacity.kind !== "capacity.provisioned") {
		throw new Error("Local build capacity was not provisioned");
	}
	const runtimeCapacity = await Promise.all(
		input.regions.map((region, index) =>
			adapter.execute(
				adapterContext({
					providerId,
					regionCode: region.code,
					correlationId: `bootstrap:${providerId}:runtime:${index}`,
				}),
				{
					kind: "capacity.provision",
					requestId: `bootstrap-runtime-${providerId}-${index}`,
					capacityKind: "runtime",
					architecture,
					cpuMillis,
					memoryMb,
					cloudInit: "#cloud-config\nwrite_files: []\n",
					labels: {
						plane: "runtime",
						owner: "deploytide",
						region: region.code,
					},
				},
			),
		),
	);
	if (
		runtimeCapacity.some((capacity) => capacity.kind !== "capacity.provisioned")
	) {
		throw new Error("Local runtime capacity was not provisioned");
	}

	await db.transaction(async (transaction) => {
		await transaction.insert(infrastructureProviders).values({
			infrastructureProviderId: providerId,
			name: input.name.trim(),
			adapterType: "local-docker",
			endpointReference: "docker://local",
			enabledRegionCodes: input.regions.map((region) => region.code),
			capabilities: probe.capabilities,
			health: "healthy",
			status: "ready",
			version: probe.version,
			lastHealthAt: new Date(),
			healthDetails: probe.details,
		});
		const createdRegions = await transaction
			.insert(regions)
			.values(
				input.regions.map((region, index) => ({
					infrastructureProviderId: providerId,
					code: region.code,
					name: region.name,
					providerRegionReference: `local-${index + 1}`,
					buildAvailable: index === 0,
					runtimeAvailable: true,
					status: "ready" as const,
					residencyMetadata: { residency: region.residency, local: true },
					routingWeight: index === 0 ? 110 : 100,
					costWeight: 100,
				})),
			)
			.returning();
		const buildRegion = createdRegions[0];
		if (!buildRegion) throw new Error("Local build region was not created");
		await transaction.insert(buildPools).values({
			infrastructureProviderId: providerId,
			regionId: buildRegion.regionId,
			name: `${input.name} rootless builds`,
			adapterType: "rootless-buildkit",
			architecture,
			workerClass: "ephemeral-standard",
			rootless: true,
			minCapacity: 0,
			maxCapacity: Math.max(2, Math.floor(cpuMillis / 1_000)),
			totalCapacity: Math.max(2, Math.floor(cpuMillis / 1_000)),
			cacheNamespace: `deploytide-${providerId}`,
			endpointReference: buildCapacity.providerTargetReference,
			health: "healthy",
			autoscalingPolicy: {
				ephemeral: true,
				scrubAfterLease: true,
				idleFloor: 0,
			},
			version: "buildkit-v0.25.1-rootless",
			lastHealthAt: new Date(),
		});
		for (const [index, region] of createdRegions.entries()) {
			const capacity = runtimeCapacity[index];
			if (!capacity || capacity.kind !== "capacity.provisioned") {
				throw new Error("Runtime capacity result is incomplete");
			}
			const [cluster] = await transaction
				.insert(runtimeClusters)
				.values({
					infrastructureProviderId: providerId,
					regionId: region.regionId,
					name: `${input.name} ${region.code}`,
					runtimeAdapter: "docker-runtime",
					endpointReference: `docker://local/${region.code}`,
					certificateReference: `operator-enrollment://${input.controllerCertificateEnrollmentId}`,
					controllerIdentity: `deploytide-controller:${providerId}:${region.code}`,
					totalCpuMillis: Math.floor(cpuMillis / 2),
					totalMemoryMb: Math.floor(memoryMb / 2),
					health: "healthy",
					controllerVersion: input.controllerVersion,
					version: probe.version,
					lastHeartbeatAt: new Date(),
				})
				.returning();
			if (!cluster) throw new Error("Local runtime cluster was not created");
			await transaction.insert(runtimeTargets).values({
				runtimeClusterId: cluster.runtimeClusterId,
				providerTargetReference: capacity.providerTargetReference,
				architecture,
				totalCpuMillis: cluster.totalCpuMillis,
				totalMemoryMb: cluster.totalMemoryMb,
				health: "healthy",
				placementLabels: {
					region: region.code,
					provider: "local-docker",
					residency: input.regions[index]?.residency ?? "local",
				},
				lastHeartbeatAt: new Date(),
				version: probe.version,
			});
		}
		if (audit) {
			await recordOperatorAudit(
				{
					...audit,
					resourceId: providerId,
					metadata: { adapterType: "local-docker", regionCount: 2 },
				},
				transaction,
			);
		}
	});
	return listOperatorInfrastructureOverview();
};

export const listOperatorInfrastructureOverview = async () => {
	const [
		providerRows,
		regionRows,
		poolRows,
		clusterRows,
		targetRows,
		leaseRows,
		attemptRows,
		incidentRows,
		legacyRows,
		certificateRows,
	] = await Promise.all([
		db.query.infrastructureProviders.findMany({
			where: isNull(infrastructureProviders.deletedAt),
			orderBy: asc(infrastructureProviders.name),
		}),
		db.query.regions.findMany({
			where: isNull(regions.deletedAt),
			orderBy: asc(regions.code),
		}),
		db.query.buildPools.findMany({
			where: isNull(buildPools.deletedAt),
			orderBy: asc(buildPools.name),
		}),
		db.query.runtimeClusters.findMany({
			where: isNull(runtimeClusters.deletedAt),
			orderBy: asc(runtimeClusters.name),
		}),
		db.query.runtimeTargets.findMany({
			where: isNull(runtimeTargets.deletedAt),
			orderBy: asc(runtimeTargets.createdAt),
		}),
		db.query.capacityLeases.findMany({
			where: inArray(capacityLeases.state, ["active", "reconciling"]),
			orderBy: asc(capacityLeases.expiresAt),
		}),
		db.query.operatorJobAttempts.findMany({
			orderBy: desc(operatorJobAttempts.createdAt),
			limit: 50,
		}),
		db.query.infrastructureIncidents.findMany({
			orderBy: desc(infrastructureIncidents.createdAt),
			limit: 50,
		}),
		db.query.legacyInfrastructureInputs.findMany({
			orderBy: desc(legacyInfrastructureInputs.createdAt),
		}),
		db.query.controllerCertificates.findMany({
			orderBy: desc(controllerCertificates.createdAt),
		}),
	]);
	return {
		providers: providerRows.map((provider) => ({
			infrastructureProviderId: provider.infrastructureProviderId,
			name: provider.name,
			adapterType: provider.adapterType,
			capabilities: provider.capabilities,
			health: provider.health,
			status: provider.status,
			version: provider.version,
			lastHealthAt: provider.lastHealthAt,
			hasSecretReference: hasOperatorSecretReference(provider.secretReference),
			regionCount: regionRows.filter(
				(region) =>
					region.infrastructureProviderId === provider.infrastructureProviderId,
			).length,
			createdAt: provider.createdAt,
		})),
		regions: regionRows.map((region) => ({
			regionId: region.regionId,
			infrastructureProviderId: region.infrastructureProviderId,
			code: region.code,
			name: region.name,
			buildAvailable: region.buildAvailable,
			runtimeAvailable: region.runtimeAvailable,
			status: region.status,
			residencyMetadata: region.residencyMetadata,
			routingWeight: region.routingWeight,
			costWeight: region.costWeight,
		})),
		buildPools: poolRows.map((pool) => ({
			buildPoolId: pool.buildPoolId,
			infrastructureProviderId: pool.infrastructureProviderId,
			regionId: pool.regionId,
			name: pool.name,
			adapterType: pool.adapterType,
			architecture: pool.architecture,
			workerClass: pool.workerClass,
			rootless: pool.rootless,
			minCapacity: pool.minCapacity,
			maxCapacity: pool.maxCapacity,
			totalCapacity: pool.totalCapacity,
			reservedCapacity: pool.reservedCapacity,
			health: pool.health,
			drainState: pool.drainState,
			version: pool.version,
			lastHealthAt: pool.lastHealthAt,
		})),
		runtimeClusters: clusterRows.map((cluster) => ({
			runtimeClusterId: cluster.runtimeClusterId,
			infrastructureProviderId: cluster.infrastructureProviderId,
			regionId: cluster.regionId,
			name: cluster.name,
			runtimeAdapter: cluster.runtimeAdapter,
			totalCpuMillis: cluster.totalCpuMillis,
			reservedCpuMillis: cluster.reservedCpuMillis,
			totalMemoryMb: cluster.totalMemoryMb,
			reservedMemoryMb: cluster.reservedMemoryMb,
			health: cluster.health,
			drainState: cluster.drainState,
			controllerVersion: cluster.controllerVersion,
			version: cluster.version,
			lastHeartbeatAt: cluster.lastHeartbeatAt,
			targetCount: targetRows.filter(
				(target) => target.runtimeClusterId === cluster.runtimeClusterId,
			).length,
		})),
		runtimeTargetCounts: {
			total: targetRows.length,
			healthy: targetRows.filter((target) => target.health === "healthy")
				.length,
			degraded: targetRows.filter((target) => target.health === "degraded")
				.length,
			unavailable: targetRows.filter(
				(target) => target.health === "unavailable",
			).length,
		},
		activeLeases: leaseRows.map((lease) => ({
			kind: lease.kind,
			leaseScope: lease.leaseScope,
			state: lease.state,
			expiresAt: lease.expiresAt,
			reservedCapacity: lease.reservedCapacity,
			reservedCpuMillis: lease.reservedCpuMillis,
			reservedMemoryMb: lease.reservedMemoryMb,
		})),
		jobSummaryCounts: attemptRows.reduce<Record<string, number>>(
			(counts, attempt) => {
				counts[attempt.status] = (counts[attempt.status] ?? 0) + 1;
				return counts;
			},
			{},
		),
		incidents: incidentRows.map((incident) => ({
			infrastructureIncidentId: incident.infrastructureIncidentId,
			infrastructureProviderId: incident.infrastructureProviderId,
			regionId: incident.regionId,
			buildPoolId: incident.buildPoolId,
			runtimeClusterId: incident.runtimeClusterId,
			severity: incident.severity,
			status: incident.status,
			title: incident.title,
			summary: incident.summary,
			createdAt: incident.createdAt,
			resolvedAt: incident.resolvedAt,
		})),
		legacyInputs: legacyRows.map((legacy) => ({
			legacyInfrastructureInputId: legacy.legacyInfrastructureInputId,
			disposition: legacy.disposition,
			hasReviewNote: Boolean(legacy.reviewNote),
			hasExport: Boolean(legacy.exportPayload),
			hasImport: Boolean(legacy.importedRuntimeTargetId),
			reviewedAt: legacy.reviewedAt,
			createdAt: legacy.createdAt,
		})),
		controllerCertificates: certificateRows.map((certificate) => ({
			controllerCertificateId: certificate.controllerCertificateId,
			runtimeClusterId: certificate.runtimeClusterId,
			status: certificate.status,
			notBefore: certificate.notBefore,
			notAfter: certificate.notAfter,
			createdAt: certificate.createdAt,
			revokedAt: certificate.revokedAt,
		})),
	};
};

const lockLegacyInfrastructureRows = async (
	transaction: DatabaseTransaction,
	serverId: string,
) => {
	await transaction.execute(sql`
		select "serverId"
		from "server"
		where "serverId" = ${serverId}
		for update
	`);
	await transaction.execute(sql`
		select "legacyInfrastructureInputId"
		from "legacyInfrastructureInput"
		where "serverId" = ${serverId}
		for update
	`);
};

export const classifyLegacyInfrastructureInput = async (
	input: {
		serverId: string;
		disposition: "ambiguous" | "platform_owned" | "customer_owned" | "rejected";
		reviewNote: string;
		reviewedBy: string;
	},
	audit?: OperatorAuditInput,
) =>
	db.transaction(async (transaction) => {
		await lockLegacyInfrastructureRows(transaction, input.serverId);
		const existingServer = await transaction.query.server.findFirst({
			where: and(eq(server.serverId, input.serverId), isNull(server.deletedAt)),
			columns: { serverId: true },
		});
		if (!existingServer)
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Legacy server input not found",
			});
		const existing =
			await transaction.query.legacyInfrastructureInputs.findFirst({
				where: eq(legacyInfrastructureInputs.serverId, input.serverId),
			});
		if (
			existing?.disposition === "imported" ||
			existing?.disposition === "exported"
		) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Imported or exported legacy inputs cannot be reclassified",
			});
		}
		const now = new Date();
		const [record] = existing
			? await transaction
					.update(legacyInfrastructureInputs)
					.set({
						disposition: input.disposition,
						reviewNote: input.reviewNote,
						reviewedBy: input.reviewedBy,
						reviewedAt: now,
						updatedAt: now,
					})
					.where(
						eq(
							legacyInfrastructureInputs.legacyInfrastructureInputId,
							existing.legacyInfrastructureInputId,
						),
					)
					.returning()
			: await transaction
					.insert(legacyInfrastructureInputs)
					.values({
						...input,
						reviewedAt: now,
					})
					.returning();
		if (!record) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Legacy infrastructure input was not classified",
			});
		}
		if (audit) {
			await recordOperatorAudit(
				{
					...audit,
					resourceId: record.legacyInfrastructureInputId,
					metadata: { disposition: input.disposition },
				},
				transaction,
			);
		}
		return record;
	});

export const resolveLegacyInfrastructureServerId = async (
	legacyInfrastructureInputId: string,
) => {
	const record = await db.query.legacyInfrastructureInputs.findFirst({
		where: eq(
			legacyInfrastructureInputs.legacyInfrastructureInputId,
			legacyInfrastructureInputId,
		),
		columns: { serverId: true },
	});
	if (!record) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Legacy infrastructure input not found",
		});
	}
	return record.serverId;
};

export const exportLegacyInfrastructureInput = async (
	input: {
		serverId: string;
		reviewedBy: string;
	},
	audit?: OperatorAuditInput,
) =>
	db.transaction(async (transaction) => {
		await lockLegacyInfrastructureRows(transaction, input.serverId);
		const legacyServer = await transaction.query.server.findFirst({
			where: and(eq(server.serverId, input.serverId), isNull(server.deletedAt)),
			columns: {
				serverId: true,
				name: true,
				description: true,
				serverType: true,
				serverStatus: true,
				createdAt: true,
			},
		});
		if (!legacyServer)
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Legacy server input not found",
			});
		const classification =
			await transaction.query.legacyInfrastructureInputs.findFirst({
				where: eq(legacyInfrastructureInputs.serverId, input.serverId),
			});
		if (classification?.disposition === "exported") {
			if (audit) {
				await recordOperatorAudit(
					{
						...audit,
						resourceId: classification.legacyInfrastructureInputId,
					},
					transaction,
				);
			}
			return classification;
		}
		const bootstrapAccess = (
			classification?.exportPayload as
				| { bootstrapAccess?: { status?: unknown } }
				| null
				| undefined
		)?.bootstrapAccess;
		if (
			classification?.disposition === "imported" ||
			bootstrapAccess?.status === "retired"
		) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Imported legacy state cannot be overwritten by export",
			});
		}
		const now = new Date();
		const exportPayload = {
			format: "deploytide.legacy-infrastructure-export.v1",
			server: legacyServer,
			exportedAt: now.toISOString(),
		};
		const [record] = classification
			? await transaction
					.update(legacyInfrastructureInputs)
					.set({
						disposition: "exported",
						exportPayload,
						reviewedBy: input.reviewedBy,
						reviewedAt: now,
						updatedAt: now,
					})
					.where(
						eq(
							legacyInfrastructureInputs.legacyInfrastructureInputId,
							classification.legacyInfrastructureInputId,
						),
					)
					.returning()
			: await transaction
					.insert(legacyInfrastructureInputs)
					.values({
						serverId: input.serverId,
						disposition: "exported",
						exportPayload,
						reviewedBy: input.reviewedBy,
						reviewedAt: now,
					})
					.returning();
		if (!record) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Legacy infrastructure input was not exported",
			});
		}
		if (audit) {
			await recordOperatorAudit(
				{ ...audit, resourceId: record.legacyInfrastructureInputId },
				transaction,
			);
		}
		return record;
	});

export const importApprovedLegacyInfrastructureInput = async (
	input: {
		serverId: string;
		runtimeClusterId: string;
		architecture: "amd64" | "arm64";
		totalCpuMillis: number;
		totalMemoryMb: number;
		reviewedBy: string;
	},
	audit?: OperatorAuditInput,
) =>
	db.transaction(async (transaction) => {
		if (
			!Number.isInteger(input.totalCpuMillis) ||
			input.totalCpuMillis <= 0 ||
			!Number.isInteger(input.totalMemoryMb) ||
			input.totalMemoryMb <= 0
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Imported capacity requires validated operator evidence",
			});
		}
		await lockLegacyInfrastructureRows(transaction, input.serverId);
		const legacyServer = await transaction.query.server.findFirst({
			where: and(eq(server.serverId, input.serverId), isNull(server.deletedAt)),
			columns: { serverId: true, name: true },
		});
		if (!legacyServer) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Legacy input or runtime cluster not found",
			});
		}
		const classification =
			await transaction.query.legacyInfrastructureInputs.findFirst({
				where: eq(legacyInfrastructureInputs.serverId, input.serverId),
			});
		if (
			classification?.disposition === "imported" &&
			classification.importedRuntimeClusterId === input.runtimeClusterId &&
			classification.importedRuntimeTargetId
		) {
			const target = await transaction.query.runtimeTargets.findFirst({
				where: and(
					eq(
						runtimeTargets.runtimeTargetId,
						classification.importedRuntimeTargetId,
					),
					eq(runtimeTargets.runtimeClusterId, input.runtimeClusterId),
					isNull(runtimeTargets.deletedAt),
				),
			});
			if (target) {
				if (audit) {
					await recordOperatorAudit(
						{
							...audit,
							resourceId: classification.legacyInfrastructureInputId,
						},
						transaction,
					);
				}
				return { classification, target };
			}
		}
		if (classification?.disposition !== "platform_owned") {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message:
					"Only explicitly approved platform-owned machines can be imported",
			});
		}
		const cluster = await transaction.query.runtimeClusters.findFirst({
			where: and(
				eq(runtimeClusters.runtimeClusterId, input.runtimeClusterId),
				isNull(runtimeClusters.deletedAt),
			),
		});
		if (!cluster)
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Legacy input or runtime cluster not found",
			});
		if (
			input.totalCpuMillis > cluster.totalCpuMillis ||
			input.totalMemoryMb > cluster.totalMemoryMb
		) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Imported target capacity exceeds its runtime cluster",
			});
		}
		const [target] = await transaction
			.insert(runtimeTargets)
			.values({
				runtimeClusterId: cluster.runtimeClusterId,
				providerTargetReference: `legacy-server:${createHash("sha256").update(legacyServer.serverId).digest("hex")}`,
				architecture: input.architecture,
				totalCpuMillis: input.totalCpuMillis,
				totalMemoryMb: input.totalMemoryMb,
				health: "unknown",
				placementLabels: { source: "legacy-approved", name: legacyServer.name },
				version: cluster.version,
			})
			.returning();
		if (!target)
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Legacy target was not imported",
			});
		const now = new Date();
		const [updated] = await transaction
			.update(legacyInfrastructureInputs)
			.set({
				disposition: "imported",
				importedRuntimeClusterId: cluster.runtimeClusterId,
				importedRuntimeTargetId: target.runtimeTargetId,
				reviewedBy: input.reviewedBy,
				reviewedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(
						legacyInfrastructureInputs.legacyInfrastructureInputId,
						classification.legacyInfrastructureInputId,
					),
					eq(legacyInfrastructureInputs.disposition, "platform_owned"),
				),
			)
			.returning();
		if (!updated) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Legacy infrastructure classification changed during import",
			});
		}
		const [updatedServer] = await transaction
			.update(server)
			.set({ operatorOwned: true })
			.where(and(eq(server.serverId, input.serverId), isNull(server.deletedAt)))
			.returning({ serverId: server.serverId });
		if (!updatedServer) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Legacy server changed during import",
			});
		}
		if (audit) {
			await recordOperatorAudit(
				{
					...audit,
					resourceId: updated.legacyInfrastructureInputId,
				},
				transaction,
			);
		}
		return { classification: updated, target };
	});

export const retireLegacyBootstrapAccess = async (
	serverId: string,
	audit?: OperatorAuditInput,
) => {
	return db.transaction(async (transaction) => {
		await lockLegacyInfrastructureRows(transaction, serverId);
		const retainedServer = await transaction.query.server.findFirst({
			where: and(eq(server.serverId, serverId), isNull(server.deletedAt)),
			columns: {
				serverId: true,
				ipAddress: true,
				port: true,
				username: true,
				sshKeyId: true,
				command: true,
			},
		});
		if (!retainedServer) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Legacy server input not found",
			});
		}
		const classification =
			await transaction.query.legacyInfrastructureInputs.findFirst({
				where: eq(legacyInfrastructureInputs.serverId, serverId),
			});
		const bootstrapAccess = (
			classification?.exportPayload as
				| { bootstrapAccess?: { status?: unknown } }
				| null
				| undefined
		)?.bootstrapAccess;
		if (bootstrapAccess?.status === "retired") {
			if (audit) await recordOperatorAudit(audit, transaction);
			return { serverId };
		}
		if (
			classification?.disposition !== "imported" ||
			!classification?.importedRuntimeClusterId ||
			!classification.importedRuntimeTargetId
		) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Legacy input is not imported",
			});
		}
		const target = await transaction.query.runtimeTargets.findFirst({
			where: and(
				eq(
					runtimeTargets.runtimeTargetId,
					classification.importedRuntimeTargetId,
				),
				eq(
					runtimeTargets.runtimeClusterId,
					classification.importedRuntimeClusterId,
				),
				eq(runtimeTargets.health, "healthy"),
				isNull(runtimeTargets.deletedAt),
			),
			columns: { lastHeartbeatAt: true },
		});
		if (
			!target?.lastHeartbeatAt ||
			target.lastHeartbeatAt < new Date(Date.now() - 60_000)
		) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message:
					"Runtime controller must be healthy before bootstrap access is removed",
			});
		}
		const now = new Date();
		const checkpoint = JSON.stringify({
			format: "deploytide.legacy-bootstrap-checkpoint.v1",
			server: retainedServer,
			runtimeClusterId: classification.importedRuntimeClusterId,
			runtimeTargetId: classification.importedRuntimeTargetId,
			checkpointedAt: now.toISOString(),
		});
		const exportPayload = {
			...(classification.exportPayload ?? {}),
			bootstrapAccess: {
				status: "retired",
				runtimeTargetId: classification.importedRuntimeTargetId,
				encryptedCheckpoint: encryptValue(checkpoint),
				checkpointDigest: createHash("sha256").update(checkpoint).digest("hex"),
				retiredAt: now.toISOString(),
			},
		};
		const [updatedClassification] = await transaction
			.update(legacyInfrastructureInputs)
			.set({ exportPayload, updatedAt: now })
			.where(
				and(
					eq(
						legacyInfrastructureInputs.legacyInfrastructureInputId,
						classification.legacyInfrastructureInputId,
					),
					eq(legacyInfrastructureInputs.disposition, "imported"),
				),
			)
			.returning({
				legacyInfrastructureInputId:
					legacyInfrastructureInputs.legacyInfrastructureInputId,
			});
		if (!updatedClassification) {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"Legacy infrastructure classification changed during retirement",
			});
		}
		const [updated] = await transaction
			.update(server)
			.set({ sshKeyId: null, command: "" })
			.where(and(eq(server.serverId, serverId), isNull(server.deletedAt)))
			.returning({ serverId: server.serverId });
		if (!updated) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Legacy server changed during bootstrap retirement",
			});
		}
		if (audit) await recordOperatorAudit(audit, transaction);
		return updated;
	});
};

export const registerControllerCertificate = async (
	input: {
		runtimeClusterId: string;
		enrollmentId: string;
	},
	audit?: OperatorAuditInput,
) => {
	let enrollment: Awaited<
		ReturnType<typeof resolveControllerCertificateEnrollment>
	>;
	try {
		enrollment = await resolveControllerCertificateEnrollment(
			input.enrollmentId,
		);
	} catch {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Controller certificate enrollment is invalid",
		});
	}
	if (!enrollment.certificatePem) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Controller certificate enrollment is invalid",
		});
	}
	const certificatePem = enrollment.certificatePem;
	let parsed: X509Certificate;
	try {
		parsed = new X509Certificate(certificatePem);
	} catch {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Controller certificate enrollment is invalid",
		});
	}
	const notBefore = new Date(parsed.validFrom);
	const notAfter = new Date(parsed.validTo);
	if (
		!Number.isFinite(notBefore.getTime()) ||
		!Number.isFinite(notAfter.getTime()) ||
		notAfter <= new Date()
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Controller certificate enrollment is invalid",
		});
	}
	return db.transaction(async (transaction) => {
		await transaction
			.update(controllerCertificates)
			.set({ status: "rotating" })
			.where(
				and(
					eq(controllerCertificates.runtimeClusterId, input.runtimeClusterId),
					eq(controllerCertificates.status, "active"),
				),
			);
		const [certificate] = await transaction
			.insert(controllerCertificates)
			.values({
				runtimeClusterId: input.runtimeClusterId,
				serialNumber: parsed.serialNumber,
				subject: parsed.subject,
				certificatePem,
				privateKeyReference: enrollment.privateKeyReference,
				caFingerprint: enrollment.caFingerprint,
				notBefore,
				notAfter,
				status: "active",
			})
			.returning();
		if (!certificate)
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Controller certificate was not registered",
			});
		if (audit) {
			await recordOperatorAudit(
				{ ...audit, resourceId: certificate.controllerCertificateId },
				transaction,
			);
		}
		return {
			controllerCertificateId: certificate.controllerCertificateId,
			runtimeClusterId: certificate.runtimeClusterId,
			status: certificate.status,
			notBefore: certificate.notBefore,
			notAfter: certificate.notAfter,
			createdAt: certificate.createdAt,
		};
	});
};

export const revokeControllerCertificate = async (
	input: {
		controllerCertificateId: string;
		reason: string;
	},
	audit?: OperatorAuditInput,
) =>
	db.transaction(async (transaction) => {
		const [certificate] = await transaction
			.update(controllerCertificates)
			.set({
				status: "revoked",
				revokedAt: new Date(),
				revocationReason: input.reason,
			})
			.where(
				and(
					eq(
						controllerCertificates.controllerCertificateId,
						input.controllerCertificateId,
					),
					inArray(controllerCertificates.status, ["active", "rotating"]),
				),
			)
			.returning();
		if (!certificate)
			throw new TRPCError({
				code: "CONFLICT",
				message: "Controller certificate is already terminal",
			});
		if (audit) {
			await recordOperatorAudit(
				{ ...audit, resourceId: certificate.controllerCertificateId },
				transaction,
			);
		}
		return {
			controllerCertificateId: certificate.controllerCertificateId,
			runtimeClusterId: certificate.runtimeClusterId,
			status: certificate.status,
			notBefore: certificate.notBefore,
			notAfter: certificate.notAfter,
			revokedAt: certificate.revokedAt,
		};
	});

export const createInfrastructureIncident = async (
	input: {
		infrastructureProviderId?: string;
		regionId?: string;
		buildPoolId?: string;
		runtimeClusterId?: string;
		severity: "info" | "warning" | "critical";
		title: string;
		summary: string;
		redactedDetails?: Record<string, unknown>;
		openedBy: string;
	},
	audit?: OperatorAuditInput,
) =>
	db.transaction(async (transaction) => {
		const [incident] = await transaction
			.insert(infrastructureIncidents)
			.values(input)
			.returning();
		if (!incident) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
		if (audit) {
			await recordOperatorAudit(
				{
					...audit,
					resourceId: incident.infrastructureIncidentId,
					metadata: { severity: incident.severity },
				},
				transaction,
			);
		}
		return incident;
	});

export const resolveInfrastructureIncident = async (
	infrastructureIncidentId: string,
	audit?: OperatorAuditInput,
) =>
	db.transaction(async (transaction) => {
		const [incident] = await transaction
			.update(infrastructureIncidents)
			.set({
				status: "resolved",
				resolvedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(
						infrastructureIncidents.infrastructureIncidentId,
						infrastructureIncidentId,
					),
					inArray(infrastructureIncidents.status, ["open", "monitoring"]),
				),
			)
			.returning();
		if (!incident)
			throw new TRPCError({
				code: "CONFLICT",
				message: "Infrastructure incident is already resolved",
			});
		if (audit) await recordOperatorAudit(audit, transaction);
		return incident;
	});

export const ensureLegacyInfrastructureInventory = async (
	transaction: DatabaseTransaction | typeof db = db,
) => {
	const serverRows = await transaction.query.server.findMany({
		where: isNull(server.deletedAt),
		columns: { serverId: true },
	});
	if (serverRows.length === 0) return 0;
	const inserted = await transaction
		.insert(legacyInfrastructureInputs)
		.values(
			serverRows.map(({ serverId }) => ({
				serverId,
				disposition: "ambiguous" as const,
			})),
		)
		.onConflictDoNothing({ target: legacyInfrastructureInputs.serverId })
		.returning({ serverId: legacyInfrastructureInputs.serverId });
	return inserted.length;
};
