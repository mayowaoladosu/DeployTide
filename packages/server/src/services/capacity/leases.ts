import { db } from "@dokploy/server/db";
import {
	buildPools,
	builds,
	capacityLeases,
	infrastructureProviders,
	operations,
	regions,
	releases,
	runtimeClusters,
	runtimeTargets,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../tenancy";

export const CAPACITY_HEALTH_FRESHNESS_MS = 60_000;
const RECONCILIATION_RETRY_MS = 5 * 60_000;
const MAX_RECONCILIATION_LIMIT = 500;

export interface CapacityPolicy {
	preferredRegionCode?: string | null;
	requiredCapabilities?: string[];
	architecture: "amd64" | "arm64";
	dataAffinity?: Record<string, string>;
	costClass?: "economy" | "balanced" | "performance";
}

interface LeaseIdentity {
	organizationId: string;
	operationId: string;
	operationFencingToken: number;
	leaseOwner: string;
	ttlMs: number;
	now?: Date;
}

export type BuildCapacityRequest = LeaseIdentity &
	(
		| { leaseScope: "workspace"; buildId: string }
		| { leaseScope: "operator"; buildId?: never }
	) & {
		capacity: number;
		policy: CapacityPolicy;
	};

export type RuntimeCapacityRequest = LeaseIdentity &
	(
		| { leaseScope: "workspace"; releaseId: string }
		| { leaseScope: "operator"; releaseId?: never }
	) & {
		cpuMillis: number;
		memoryMb: number;
		policy: CapacityPolicy;
	};

type CapacityLeaseRecord = typeof capacityLeases.$inferSelect;

const assertLeaseInput = (input: LeaseIdentity) => {
	if (
		!input.organizationId ||
		!input.operationId ||
		!Number.isSafeInteger(input.operationFencingToken) ||
		input.operationFencingToken < 1 ||
		!input.leaseOwner
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Capacity lease identity is incomplete",
		});
	}
	if (
		!Number.isInteger(input.ttlMs) ||
		input.ttlMs < 5_000 ||
		input.ttlMs > 30 * 60_000
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Capacity lease TTL is outside the allowed range",
		});
	}
};

const providerSupports = (
	capabilities: string[],
	required: string[] | undefined,
) => (required ?? []).every((capability) => capabilities.includes(capability));

const matchesAffinity = (
	labels: Record<string, string>,
	affinity: Record<string, string> | undefined,
) =>
	Object.entries(affinity ?? {}).every(([key, value]) => labels[key] === value);

const scoreCandidate = (input: {
	preferredRegionCode?: string | null;
	regionCode: string;
	reserved: number;
	total: number;
	costWeight: number;
	routingWeight: number;
	costClass?: CapacityPolicy["costClass"];
}) => {
	const regionPenalty =
		input.preferredRegionCode && input.preferredRegionCode !== input.regionCode
			? 1_000_000
			: 0;
	const occupancy =
		input.total > 0 ? (input.reserved / input.total) * 10_000 : 10_000;
	const costMultiplier =
		input.costClass === "economy"
			? 4
			: input.costClass === "performance"
				? 0.25
				: 1;
	const occupancyMultiplier = input.costClass === "performance" ? 2 : 1;
	return (
		regionPenalty +
		occupancy * occupancyMultiplier +
		input.costWeight * costMultiplier -
		input.routingWeight
	);
};

const lockAndValidateOperationClaim = async (
	transaction: DatabaseTransaction,
	input: LeaseIdentity & { leaseScope: "workspace" | "operator" },
	now: Date,
) => {
	await transaction.execute(sql`
		select "operationId"
		from "operation"
		where "operationId" = ${input.operationId}
			and "organizationId" = ${input.organizationId}
			and "fencingToken" = ${input.operationFencingToken}
		for update
	`);
	const operation = await transaction.query.operations.findFirst({
		where: and(
			eq(operations.operationId, input.operationId),
			eq(operations.organizationId, input.organizationId),
		),
	});
	if (!operation) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Operation not found" });
	}
	if (
		operation.status !== "running" ||
		operation.leaseOwner !== input.leaseOwner ||
		operation.fencingToken !== input.operationFencingToken ||
		!operation.leaseExpiresAt ||
		operation.leaseExpiresAt <= now
	) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Capacity requires an unexpired scheduler-owned operation claim",
		});
	}
	if (
		input.leaseScope === "operator" &&
		operation.actorType !== "operator" &&
		operation.actorType !== "system"
	) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Operator capacity requires an operator or system operation",
		});
	}
	const requestedExpiry = new Date(now.getTime() + input.ttlMs);
	if (requestedExpiry > operation.leaseExpiresAt) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Capacity lease cannot outlive its operation claim",
		});
	}
	const existing = await transaction.query.capacityLeases.findFirst({
		where: and(
			eq(capacityLeases.operationId, input.operationId),
			inArray(capacityLeases.state, ["active", "releasing", "reconciling"]),
		),
		columns: { capacityLeaseId: true },
	});
	if (existing) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Operation already owns reserved capacity",
		});
	}
	return requestedExpiry;
};

const validateBuildOwnership = async (
	transaction: DatabaseTransaction,
	input: BuildCapacityRequest,
) => {
	if (input.leaseScope === "operator") return;
	const build = await transaction.query.builds.findFirst({
		where: and(
			eq(builds.buildId, input.buildId),
			eq(builds.organizationId, input.organizationId),
			eq(builds.operationId, input.operationId),
		),
		columns: { buildId: true },
	});
	if (!build) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Build, operation, and workspace ownership do not agree",
		});
	}
};

const validateReleaseOwnership = async (
	transaction: DatabaseTransaction,
	input: RuntimeCapacityRequest,
) => {
	if (input.leaseScope === "operator") return;
	const release = await transaction.query.releases.findFirst({
		where: and(
			eq(releases.releaseId, input.releaseId),
			eq(releases.organizationId, input.organizationId),
			eq(releases.operationId, input.operationId),
		),
		columns: { releaseId: true },
	});
	if (!release) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Release, operation, and workspace ownership do not agree",
		});
	}
};

export const acquireBuildCapacityLease = async (
	input: BuildCapacityRequest,
) => {
	assertLeaseInput(input);
	if (!Number.isInteger(input.capacity) || input.capacity <= 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Build capacity must be positive",
		});
	}
	const now = input.now ?? new Date();
	const freshnessCutoff = new Date(
		now.getTime() - CAPACITY_HEALTH_FRESHNESS_MS,
	);
	const rows = await db
		.select({
			pool: buildPools,
			regionCode: regions.code,
			regionCostWeight: regions.costWeight,
			regionRoutingWeight: regions.routingWeight,
			providerAdapterType: infrastructureProviders.adapterType,
			providerCapabilities: infrastructureProviders.capabilities,
		})
		.from(buildPools)
		.innerJoin(regions, eq(regions.regionId, buildPools.regionId))
		.innerJoin(
			infrastructureProviders,
			eq(
				infrastructureProviders.infrastructureProviderId,
				buildPools.infrastructureProviderId,
			),
		)
		.where(
			and(
				isNull(buildPools.deletedAt),
				isNull(regions.deletedAt),
				isNull(infrastructureProviders.deletedAt),
				eq(buildPools.architecture, input.policy.architecture),
				eq(buildPools.rootless, true),
				eq(buildPools.health, "healthy"),
				gt(buildPools.lastHealthAt, freshnessCutoff),
				eq(buildPools.drainState, "active"),
				eq(regions.buildAvailable, true),
				eq(regions.status, "ready"),
				eq(infrastructureProviders.health, "healthy"),
				gt(infrastructureProviders.lastHealthAt, freshnessCutoff),
				eq(infrastructureProviders.status, "ready"),
			),
		);
	const candidates = rows
		.filter(
			(row) =>
				providerSupports(
					row.providerCapabilities,
					input.policy.requiredCapabilities,
				) &&
				matchesAffinity(
					{
						region: row.regionCode,
						workerClass: row.pool.workerClass,
						cacheNamespace: row.pool.cacheNamespace,
						provider: row.providerAdapterType,
					},
					input.policy.dataAffinity,
				),
		)
		.sort((left, right) => {
			const difference =
				scoreCandidate({
					preferredRegionCode: input.policy.preferredRegionCode,
					regionCode: left.regionCode,
					reserved: left.pool.reservedCapacity,
					total: left.pool.totalCapacity,
					costWeight: left.regionCostWeight,
					routingWeight: left.regionRoutingWeight,
					costClass: input.policy.costClass,
				}) -
				scoreCandidate({
					preferredRegionCode: input.policy.preferredRegionCode,
					regionCode: right.regionCode,
					reserved: right.pool.reservedCapacity,
					total: right.pool.totalCapacity,
					costWeight: right.regionCostWeight,
					routingWeight: right.regionRoutingWeight,
					costClass: input.policy.costClass,
				});
			return (
				difference ||
				left.pool.buildPoolId.localeCompare(right.pool.buildPoolId)
			);
		});

	for (const candidate of candidates) {
		const lease = await db.transaction(async (transaction) => {
			const requestedExpiry = await lockAndValidateOperationClaim(
				transaction,
				input,
				now,
			);
			await validateBuildOwnership(transaction, input);
			const [reserved] = await transaction
				.update(buildPools)
				.set({
					reservedCapacity: sql`${buildPools.reservedCapacity} + ${input.capacity}`,
					updatedAt: now,
				})
				.where(
					and(
						eq(buildPools.buildPoolId, candidate.pool.buildPoolId),
						eq(buildPools.health, "healthy"),
						gt(buildPools.lastHealthAt, freshnessCutoff),
						eq(buildPools.drainState, "active"),
						sql`${buildPools.reservedCapacity} + ${input.capacity} <= ${buildPools.totalCapacity}`,
					),
				)
				.returning({ buildPoolId: buildPools.buildPoolId });
			if (!reserved) return null;
			const [created] = await transaction
				.insert(capacityLeases)
				.values({
					organizationId: input.organizationId,
					operationId: input.operationId,
					buildId: input.leaseScope === "workspace" ? input.buildId : undefined,
					buildPoolId: reserved.buildPoolId,
					kind: "build",
					leaseScope: input.leaseScope,
					reservedCapacity: input.capacity,
					leaseOwner: input.leaseOwner,
					expiresAt: requestedExpiry,
				})
				.returning();
			return created ?? null;
		});
		if (lease) return lease;
	}
	throw new TRPCError({
		code: "TOO_MANY_REQUESTS",
		message: "No fresh healthy rootless build capacity is currently available",
	});
};

export const acquireRuntimeCapacityLease = async (
	input: RuntimeCapacityRequest,
) => {
	assertLeaseInput(input);
	if (
		!Number.isInteger(input.cpuMillis) ||
		input.cpuMillis <= 0 ||
		!Number.isInteger(input.memoryMb) ||
		input.memoryMb <= 0
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Runtime reservation must be positive",
		});
	}
	const now = input.now ?? new Date();
	const freshnessCutoff = new Date(
		now.getTime() - CAPACITY_HEALTH_FRESHNESS_MS,
	);
	const rows = await db
		.select({
			cluster: runtimeClusters,
			target: runtimeTargets,
			regionCode: regions.code,
			regionCostWeight: regions.costWeight,
			regionRoutingWeight: regions.routingWeight,
			providerCapabilities: infrastructureProviders.capabilities,
		})
		.from(runtimeTargets)
		.innerJoin(
			runtimeClusters,
			eq(runtimeClusters.runtimeClusterId, runtimeTargets.runtimeClusterId),
		)
		.innerJoin(regions, eq(regions.regionId, runtimeClusters.regionId))
		.innerJoin(
			infrastructureProviders,
			eq(
				infrastructureProviders.infrastructureProviderId,
				runtimeClusters.infrastructureProviderId,
			),
		)
		.where(
			and(
				isNull(runtimeTargets.deletedAt),
				isNull(runtimeClusters.deletedAt),
				isNull(regions.deletedAt),
				isNull(infrastructureProviders.deletedAt),
				eq(runtimeTargets.architecture, input.policy.architecture),
				eq(runtimeTargets.health, "healthy"),
				gt(runtimeTargets.lastHeartbeatAt, freshnessCutoff),
				eq(runtimeTargets.drainState, "active"),
				eq(runtimeClusters.health, "healthy"),
				gt(runtimeClusters.lastHeartbeatAt, freshnessCutoff),
				eq(runtimeClusters.drainState, "active"),
				eq(regions.runtimeAvailable, true),
				eq(regions.status, "ready"),
				eq(infrastructureProviders.health, "healthy"),
				gt(infrastructureProviders.lastHealthAt, freshnessCutoff),
				eq(infrastructureProviders.status, "ready"),
			),
		);
	const candidates = rows
		.filter(
			(row) =>
				providerSupports(
					row.providerCapabilities,
					input.policy.requiredCapabilities,
				) &&
				matchesAffinity(row.target.placementLabels, input.policy.dataAffinity),
		)
		.sort((left, right) => {
			const difference =
				scoreCandidate({
					preferredRegionCode: input.policy.preferredRegionCode,
					regionCode: left.regionCode,
					reserved: left.target.reservedCpuMillis,
					total: left.target.totalCpuMillis,
					costWeight: left.regionCostWeight,
					routingWeight: left.regionRoutingWeight,
					costClass: input.policy.costClass,
				}) -
				scoreCandidate({
					preferredRegionCode: input.policy.preferredRegionCode,
					regionCode: right.regionCode,
					reserved: right.target.reservedCpuMillis,
					total: right.target.totalCpuMillis,
					costWeight: right.regionCostWeight,
					routingWeight: right.regionRoutingWeight,
					costClass: input.policy.costClass,
				});
			return (
				difference ||
				left.target.runtimeTargetId.localeCompare(right.target.runtimeTargetId)
			);
		});

	for (const candidate of candidates) {
		const lease = await db
			.transaction(async (transaction) => {
				const requestedExpiry = await lockAndValidateOperationClaim(
					transaction,
					input,
					now,
				);
				await validateReleaseOwnership(transaction, input);
				const [cluster] = await transaction
					.update(runtimeClusters)
					.set({
						reservedCpuMillis: sql`${runtimeClusters.reservedCpuMillis} + ${input.cpuMillis}`,
						reservedMemoryMb: sql`${runtimeClusters.reservedMemoryMb} + ${input.memoryMb}`,
						updatedAt: now,
					})
					.where(
						and(
							eq(
								runtimeClusters.runtimeClusterId,
								candidate.cluster.runtimeClusterId,
							),
							eq(runtimeClusters.health, "healthy"),
							gt(runtimeClusters.lastHeartbeatAt, freshnessCutoff),
							eq(runtimeClusters.drainState, "active"),
							sql`${runtimeClusters.reservedCpuMillis} + ${input.cpuMillis} <= ${runtimeClusters.totalCpuMillis}`,
							sql`${runtimeClusters.reservedMemoryMb} + ${input.memoryMb} <= ${runtimeClusters.totalMemoryMb}`,
						),
					)
					.returning({ runtimeClusterId: runtimeClusters.runtimeClusterId });
				if (!cluster) return null;
				const [target] = await transaction
					.update(runtimeTargets)
					.set({
						reservedCpuMillis: sql`${runtimeTargets.reservedCpuMillis} + ${input.cpuMillis}`,
						reservedMemoryMb: sql`${runtimeTargets.reservedMemoryMb} + ${input.memoryMb}`,
						updatedAt: now,
					})
					.where(
						and(
							eq(
								runtimeTargets.runtimeTargetId,
								candidate.target.runtimeTargetId,
							),
							eq(runtimeTargets.runtimeClusterId, cluster.runtimeClusterId),
							eq(runtimeTargets.health, "healthy"),
							gt(runtimeTargets.lastHeartbeatAt, freshnessCutoff),
							eq(runtimeTargets.drainState, "active"),
							sql`${runtimeTargets.reservedCpuMillis} + ${input.cpuMillis} <= ${runtimeTargets.totalCpuMillis}`,
							sql`${runtimeTargets.reservedMemoryMb} + ${input.memoryMb} <= ${runtimeTargets.totalMemoryMb}`,
						),
					)
					.returning({ runtimeTargetId: runtimeTargets.runtimeTargetId });
				if (!target) {
					throw new TRPCError({
						code: "CONFLICT",
						message: "Runtime target capacity changed",
					});
				}
				const [created] = await transaction
					.insert(capacityLeases)
					.values({
						organizationId: input.organizationId,
						operationId: input.operationId,
						releaseId:
							input.leaseScope === "workspace" ? input.releaseId : undefined,
						runtimeClusterId: cluster.runtimeClusterId,
						runtimeTargetId: target.runtimeTargetId,
						kind: "runtime",
						leaseScope: input.leaseScope,
						reservedCpuMillis: input.cpuMillis,
						reservedMemoryMb: input.memoryMb,
						leaseOwner: input.leaseOwner,
						expiresAt: requestedExpiry,
					})
					.returning();
				return created ?? null;
			})
			.catch((error) => {
				if (error instanceof TRPCError && error.code === "CONFLICT")
					return null;
				throw error;
			});
		if (lease) return lease;
	}
	throw new TRPCError({
		code: "TOO_MANY_REQUESTS",
		message: "No fresh healthy runtime capacity is currently available",
	});
};

export const renewCapacityLease = async (input: {
	capacityLeaseId: string;
	leaseOwner: string;
	fencingToken: number;
	ttlMs: number;
	now?: Date;
}) => {
	if (
		!Number.isInteger(input.ttlMs) ||
		input.ttlMs < 5_000 ||
		input.ttlMs > 30 * 60_000
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Capacity lease TTL is outside the allowed range",
		});
	}
	const now = input.now ?? new Date();
	const nextExpiry = new Date(now.getTime() + input.ttlMs);
	const [renewed] = await db
		.update(capacityLeases)
		.set({
			expiresAt: nextExpiry,
			updatedAt: now,
		})
		.where(
			and(
				eq(capacityLeases.capacityLeaseId, input.capacityLeaseId),
				eq(capacityLeases.leaseOwner, input.leaseOwner),
				eq(capacityLeases.fencingToken, input.fencingToken),
				eq(capacityLeases.state, "active"),
				gt(capacityLeases.expiresAt, now),
				sql`exists (
					select 1
					from "operation" operation
					where operation."operationId" = ${capacityLeases.operationId}
						and operation."organizationId" = ${capacityLeases.organizationId}
						and operation.status = 'running'
						and operation."leaseOwner" = ${capacityLeases.leaseOwner}
						and operation."leaseExpiresAt" >= ${nextExpiry.toISOString()}::timestamptz
				)`,
			),
		)
		.returning();
	if (!renewed) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Capacity lease is expired or no longer owned by this worker",
		});
	}
	return renewed;
};

const decrementReservation = async (
	transaction: DatabaseTransaction,
	lease: CapacityLeaseRecord,
	now: Date,
) => {
	if (lease.buildPoolId) {
		const [pool] = await transaction
			.update(buildPools)
			.set({
				reservedCapacity: sql`${buildPools.reservedCapacity} - ${lease.reservedCapacity}`,
				updatedAt: now,
			})
			.where(
				and(
					eq(buildPools.buildPoolId, lease.buildPoolId),
					sql`${buildPools.reservedCapacity} >= ${lease.reservedCapacity}`,
				),
			)
			.returning({ buildPoolId: buildPools.buildPoolId });
		if (!pool) throw new Error("Build capacity counter is inconsistent");
	}
	if (lease.runtimeClusterId) {
		const [cluster] = await transaction
			.update(runtimeClusters)
			.set({
				reservedCpuMillis: sql`${runtimeClusters.reservedCpuMillis} - ${lease.reservedCpuMillis}`,
				reservedMemoryMb: sql`${runtimeClusters.reservedMemoryMb} - ${lease.reservedMemoryMb}`,
				updatedAt: now,
			})
			.where(
				and(
					eq(runtimeClusters.runtimeClusterId, lease.runtimeClusterId),
					sql`${runtimeClusters.reservedCpuMillis} >= ${lease.reservedCpuMillis}`,
					sql`${runtimeClusters.reservedMemoryMb} >= ${lease.reservedMemoryMb}`,
				),
			)
			.returning({ runtimeClusterId: runtimeClusters.runtimeClusterId });
		if (!cluster)
			throw new Error("Runtime cluster capacity counter is inconsistent");
	}
	if (lease.runtimeTargetId) {
		const [target] = await transaction
			.update(runtimeTargets)
			.set({
				reservedCpuMillis: sql`${runtimeTargets.reservedCpuMillis} - ${lease.reservedCpuMillis}`,
				reservedMemoryMb: sql`${runtimeTargets.reservedMemoryMb} - ${lease.reservedMemoryMb}`,
				updatedAt: now,
			})
			.where(
				and(
					eq(runtimeTargets.runtimeTargetId, lease.runtimeTargetId),
					sql`${runtimeTargets.reservedCpuMillis} >= ${lease.reservedCpuMillis}`,
					sql`${runtimeTargets.reservedMemoryMb} >= ${lease.reservedMemoryMb}`,
				),
			)
			.returning({ runtimeTargetId: runtimeTargets.runtimeTargetId });
		if (!target)
			throw new Error("Runtime target capacity counter is inconsistent");
	}
};

export const releaseCapacityLease = async (input: {
	capacityLeaseId: string;
	leaseOwner: string;
	fencingToken: number;
	now?: Date;
}) => {
	const now = input.now ?? new Date();
	return db.transaction(async (transaction) => {
		const [claimed] = await transaction
			.update(capacityLeases)
			.set({ state: "releasing", updatedAt: now })
			.where(
				and(
					eq(capacityLeases.capacityLeaseId, input.capacityLeaseId),
					eq(capacityLeases.leaseOwner, input.leaseOwner),
					eq(capacityLeases.fencingToken, input.fencingToken),
					eq(capacityLeases.state, "active"),
					gt(capacityLeases.expiresAt, now),
				),
			)
			.returning();
		if (!claimed) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Capacity lease is expired or no longer owned by this worker",
			});
		}
		await decrementReservation(transaction, claimed, now);
		const [released] = await transaction
			.update(capacityLeases)
			.set({
				state: "released",
				reconciliationState: "clean",
				reconciliationError: null,
				updatedAt: now,
				releasedAt: now,
			})
			.where(
				and(
					eq(capacityLeases.capacityLeaseId, input.capacityLeaseId),
					eq(capacityLeases.state, "releasing"),
				),
			)
			.returning();
		if (!released) throw new Error("Capacity lease release lost its claim");
		return released;
	});
};

export interface BuildCleanupProof {
	status: "clean";
	proofId: string;
	residue: {
		workers: number;
		containers: number;
		networks: number;
		volumes: number;
	};
}

export interface RuntimeCleanupProof {
	status: "clean";
	proofId: string;
	placementDrained: true;
}

export interface CleanupPending {
	status: "pending";
	reason: string;
}

export interface CapacityReconciliationContext {
	lease: CapacityLeaseRecord;
	release: null | {
		releaseId: string;
		runtimeTargetId: string | null;
		runtimePlacementId: string | null;
		status: string;
	};
	now: Date;
}

export type BuildCapacityReconciler = (
	context: CapacityReconciliationContext,
) => Promise<BuildCleanupProof | CleanupPending>;
export type RuntimeCapacityReconciler = (
	context: CapacityReconciliationContext,
) => Promise<RuntimeCleanupProof | CleanupPending>;

export class CapacityReconciliationRegistry {
	#build?: BuildCapacityReconciler;
	#runtime?: RuntimeCapacityReconciler;

	registerBuild(reconciler: BuildCapacityReconciler): this {
		this.#build = reconciler;
		return this;
	}

	registerRuntime(reconciler: RuntimeCapacityReconciler): this {
		this.#runtime = reconciler;
		return this;
	}

	resolveBuild() {
		return this.#build;
	}

	resolveRuntime() {
		return this.#runtime;
	}
}

export const defaultCapacityReconciliationRegistry =
	new CapacityReconciliationRegistry();

const reconciliationMessage = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).slice(0, 1_000);

const markReconciliation = async (
	capacityLeaseId: string,
	state: "pending" | "failed",
	message: string,
	now: Date,
) => {
	await db
		.update(capacityLeases)
		.set({
			reconciliationState: state,
			reconciliationError: message.slice(0, 1_000),
			updatedAt: now,
		})
		.where(
			and(
				eq(capacityLeases.capacityLeaseId, capacityLeaseId),
				eq(capacityLeases.state, "reconciling"),
				eq(capacityLeases.reconciliationState, "running"),
			),
		);
};

const assertCleanupProof = (
	lease: CapacityLeaseRecord,
	proof: BuildCleanupProof | RuntimeCleanupProof,
) => {
	if (!proof.proofId.trim())
		throw new Error("Cleanup proof identity is missing");
	if (lease.kind === "build") {
		if (!("residue" in proof)) {
			throw new Error("Build cleanup did not report lease-labeled residue");
		}
		if (
			Object.values(proof.residue).some(
				(value) => !Number.isInteger(value) || value !== 0,
			)
		) {
			throw new Error("Build cleanup still has lease-labeled residue");
		}
		return;
	}
	if (!("placementDrained" in proof) || proof.placementDrained !== true) {
		throw new Error("Runtime cleanup did not prove the placement was drained");
	}
};

const finalizeExpiredReservation = async (
	lease: CapacityLeaseRecord,
	now: Date,
) =>
	db.transaction(async (transaction) => {
		const current = await transaction.query.capacityLeases.findFirst({
			where: and(
				eq(capacityLeases.capacityLeaseId, lease.capacityLeaseId),
				eq(capacityLeases.fencingToken, lease.fencingToken),
				eq(capacityLeases.state, "reconciling"),
				eq(capacityLeases.reconciliationState, "running"),
			),
		});
		if (!current) return null;
		await decrementReservation(transaction, current, now);
		const [expired] = await transaction
			.update(capacityLeases)
			.set({
				state: "expired",
				reconciliationState: "recovered",
				reconciliationError: null,
				updatedAt: now,
				releasedAt: now,
			})
			.where(
				and(
					eq(capacityLeases.capacityLeaseId, current.capacityLeaseId),
					eq(capacityLeases.fencingToken, current.fencingToken),
					eq(capacityLeases.state, "reconciling"),
					eq(capacityLeases.reconciliationState, "running"),
				),
			)
			.returning();
		if (!expired)
			throw new Error("Expired capacity finalization lost its claim");
		return expired;
	});

export const reconcileExpiredCapacityLeases = async (
	input:
		| number
		| {
				limit?: number;
				registry?: CapacityReconciliationRegistry;
				now?: Date;
		  } = {},
) => {
	const options = typeof input === "number" ? { limit: input } : input;
	const limit = options.limit ?? 100;
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > MAX_RECONCILIATION_LIMIT
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Capacity reconciliation limit is invalid",
		});
	}
	const now = options.now ?? new Date();
	const retryCutoff = new Date(now.getTime() - RECONCILIATION_RETRY_MS);
	const claimedResult = await db.execute(sql`
		with candidate as materialized (
			select l."capacityLeaseId"
			from "capacityLease" l
			where l."expiresAt" <= ${now.toISOString()}::timestamptz
				and (
					l.state = 'active'
					or (
						l.state = 'reconciling'
						and (
							l."reconciliationState" in ('pending', 'failed')
							or (
								l."reconciliationState" = 'running'
								and l."updatedAt" <= ${retryCutoff.toISOString()}::timestamptz
							)
						)
					)
				)
			order by l."expiresAt", l."capacityLeaseId"
			limit ${limit}
			for update skip locked
		)
		update "capacityLease" l
		set state = 'reconciling',
			"reconciliationState" = 'running',
			"reconciliationAttempts" = l."reconciliationAttempts" + 1,
			"reconciliationError" = null,
			"updatedAt" = ${now.toISOString()}::timestamptz
		from candidate
		where l."capacityLeaseId" = candidate."capacityLeaseId"
		returning l.*
	`);
	const claimed = Array.from(claimedResult) as unknown as CapacityLeaseRecord[];
	const registry = options.registry ?? defaultCapacityReconciliationRegistry;
	const summary = {
		examined: claimed.length,
		recovered: [] as string[],
		pending: [] as string[],
		failed: [] as string[],
	};
	for (const lease of claimed) {
		const release =
			(lease.releaseId
				? await db.query.releases.findFirst({
						where: and(
							eq(releases.releaseId, lease.releaseId),
							eq(releases.organizationId, lease.organizationId),
						),
						columns: {
							releaseId: true,
							runtimeTargetId: true,
							runtimePlacementId: true,
							status: true,
						},
					})
				: null) ?? null;
		const context: CapacityReconciliationContext = { lease, release, now };
		const reconciler =
			lease.kind === "build"
				? registry.resolveBuild()
				: registry.resolveRuntime();
		if (!reconciler) {
			await markReconciliation(
				lease.capacityLeaseId,
				"pending",
				`${lease.kind} cleanup reconciler is unavailable`,
				now,
			);
			summary.pending.push(lease.capacityLeaseId);
			continue;
		}
		try {
			const proof = await reconciler(context);
			if (proof.status === "pending") {
				await markReconciliation(
					lease.capacityLeaseId,
					"pending",
					proof.reason,
					now,
				);
				summary.pending.push(lease.capacityLeaseId);
				continue;
			}
			assertCleanupProof(lease, proof);
			if (await finalizeExpiredReservation(lease, now)) {
				summary.recovered.push(lease.capacityLeaseId);
			}
		} catch (error) {
			await markReconciliation(
				lease.capacityLeaseId,
				"failed",
				reconciliationMessage(error),
				now,
			);
			summary.failed.push(lease.capacityLeaseId);
		}
	}
	return summary;
};

export const claimNextFairOperation = async (input: {
	kind: string;
	leaseOwner: string;
	ttlMs: number;
	now?: Date;
}) => {
	if (
		!input.kind ||
		!input.leaseOwner ||
		!Number.isInteger(input.ttlMs) ||
		input.ttlMs < 5_000 ||
		input.ttlMs > 30 * 60_000
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Scheduler claim is invalid",
		});
	}
	const now = input.now ?? new Date();
	const expiresAt = new Date(now.getTime() + input.ttlMs);
	const result = await db.execute(sql`
		with queued as materialized (
			select
				o."operationId",
				o."organizationId",
				o."createdAt",
				greatest(1, least(10000, coalesce(policy."fairQueueWeight", 100)))::numeric as weight,
				row_number() over (
					partition by o."organizationId"
					order by o."createdAt", o."operationId"
				) as workspace_rank
			from "operation" o
			left join "build" b
				on o."resourceType" = 'build' and b."buildId" = o."resourceId"
			left join "release" r
				on o."resourceType" = 'release' and r."releaseId" = o."resourceId"
			left join "projectPlacementPolicy" policy
				on policy."organizationId" = o."organizationId"
				and policy."projectId" = coalesce(
					b."projectId",
					r."projectId",
					case when o."resourceType" = 'project' then o."resourceId" end
				)
			where o.status = 'pending' and o.kind = ${input.kind}
		), workspace_load as materialized (
			select
				workspace.id as organization_id,
				(
					select count(*)::numeric
					from "capacityLease" l
					where l."organizationId" = workspace.id
						and l.state in ('active', 'releasing', 'reconciling')
				) + (
					select count(*)::numeric
					from "operation" claimed
					where claimed."organizationId" = workspace.id
						and claimed.status = 'running'
						and claimed."leaseExpiresAt" > ${now.toISOString()}::timestamptz
				) as load
			from "organization" workspace
		), candidate as (
			select q."operationId"
			from queued q
			join "organization" workspace on workspace.id = q."organizationId"
			left join workspace_load load on load.organization_id = q."organizationId"
			where q.workspace_rank = 1
			order by
				((coalesce(load.load, 0) + 1) / q.weight),
				q."createdAt",
				q."organizationId",
				q."operationId"
			limit 1
			for update of workspace skip locked
		)
		update "operation" o
		set status = 'running',
			"leaseOwner" = ${input.leaseOwner},
			"leaseExpiresAt" = ${expiresAt.toISOString()}::timestamptz,
			"fencingToken" = o."fencingToken" + 1,
			attempts = o.attempts + 1,
			"updatedAt" = ${now.toISOString()}::timestamptz
		from candidate
		where o."operationId" = candidate."operationId" and o.status = 'pending'
		returning o.*
	`);
	const claimed = result[0] as
		| (Record<string, unknown> & {
				fencingToken: number | string;
				attempts: number | string;
		  })
		| undefined;
	if (!claimed) return null;
	const fencingToken = Number(claimed.fencingToken);
	const attempts = Number(claimed.attempts);
	if (!Number.isSafeInteger(fencingToken) || !Number.isSafeInteger(attempts)) {
		throw new Error("Scheduler claim returned an unsafe operation fence");
	}
	return { ...claimed, fencingToken, attempts };
};

export const reconcileExpiredOperationClaims = async (
	limit = 100,
	now = new Date(),
) => {
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > MAX_RECONCILIATION_LIMIT
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Operation reconciliation limit is invalid",
		});
	}
	const result = await db.execute(sql`
		with candidate as materialized (
			select o."operationId"
			from "operation" o
			where o.status = 'running'
				and o."leaseExpiresAt" <= ${now.toISOString()}::timestamptz
			order by o."leaseExpiresAt", o."operationId"
			limit ${limit}
			for update skip locked
		)
		update "operation" o
		set status = 'pending',
			"leaseOwner" = null,
			"leaseExpiresAt" = null,
			"fencingToken" = o."fencingToken" + 1,
			"updatedAt" = ${now.toISOString()}::timestamptz
		from candidate
		where o."operationId" = candidate."operationId"
			and o.status = 'running'
			and o."leaseExpiresAt" <= ${now.toISOString()}::timestamptz
		returning o."operationId"
	`);
	return result.length;
};

export const activeLeaseCountsByWorkspace = async () =>
	db
		.select({
			organizationId: capacityLeases.organizationId,
			count: sql<number>`count(*)::int`,
		})
		.from(capacityLeases)
		.where(
			inArray(capacityLeases.state, ["active", "releasing", "reconciling"]),
		)
		.groupBy(capacityLeases.organizationId)
		.orderBy(asc(capacityLeases.organizationId));

export const findActiveLeasesForResources = async (resourceIds: string[]) => {
	if (resourceIds.length === 0) return [];
	return db.query.capacityLeases.findMany({
		where: and(
			inArray(capacityLeases.state, ["active", "releasing", "reconciling"]),
			inArray(capacityLeases.runtimeClusterId, resourceIds),
		),
	});
};
