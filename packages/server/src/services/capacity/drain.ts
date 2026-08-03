import { db } from "@dokploy/server/db";
import {
	capacityLeases,
	projectPlacementPolicies,
	releases,
	runtimeClusters,
	runtimeTargets,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { CAPACITY_HEALTH_FRESHNESS_MS } from "./leases";

export interface PreparedRuntimeRelocation {
	runtimeTargetId: string;
	runtimePlacementId: string;
	placementHealth: "healthy";
	trafficReady: true;
	aliasReady: true;
	readinessProof: string;
}

export interface RuntimeReleaseRelocator {
	prepare(input: {
		relocationId: string;
		releaseId: string;
		organizationId: string;
		projectId: string;
		excludedRuntimeClusterId: string;
		previousRuntimeTargetId: string;
		previousRuntimePlacementId: string;
	}): Promise<PreparedRuntimeRelocation>;
	drainPrevious(input: {
		relocationId: string;
		releaseId: string;
		runtimeTargetId: string;
		runtimePlacementId: string;
	}): Promise<{ drained: true; proofId: string }>;
}

let registeredRuntimeReleaseRelocator: RuntimeReleaseRelocator | null = null;

export const registerRuntimeReleaseRelocator = (
	relocator: RuntimeReleaseRelocator,
) => {
	registeredRuntimeReleaseRelocator = relocator;
	return () => {
		if (registeredRuntimeReleaseRelocator === relocator) {
			registeredRuntimeReleaseRelocator = null;
		}
	};
};

export const requestRuntimeClusterDrain = async (runtimeClusterId: string) =>
	db.transaction(async (transaction) => {
		const [cluster] = await transaction
			.update(runtimeClusters)
			.set({ drainState: "draining", updatedAt: new Date() })
			.where(
				and(
					eq(runtimeClusters.runtimeClusterId, runtimeClusterId),
					eq(runtimeClusters.drainState, "active"),
					isNull(runtimeClusters.deletedAt),
				),
			)
			.returning();
		const current =
			cluster ??
			(await transaction.query.runtimeClusters.findFirst({
				where: and(
					eq(runtimeClusters.runtimeClusterId, runtimeClusterId),
					isNull(runtimeClusters.deletedAt),
				),
			}));
		if (!current) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Runtime cluster not found",
			});
		}
		if (current.drainState !== "drained") {
			await transaction
				.update(runtimeTargets)
				.set({ drainState: "draining", updatedAt: new Date() })
				.where(
					and(
						eq(runtimeTargets.runtimeClusterId, runtimeClusterId),
						isNull(runtimeTargets.deletedAt),
					),
				);
		}
		return current;
	});

const targetIdsForCluster = async (runtimeClusterId: string) =>
	(
		await db.query.runtimeTargets.findMany({
			where: and(
				eq(runtimeTargets.runtimeClusterId, runtimeClusterId),
				isNull(runtimeTargets.deletedAt),
			),
			columns: { runtimeTargetId: true },
		})
	).map((target) => target.runtimeTargetId);

const blockingReleases = async (targetIds: string[]) => {
	if (targetIds.length === 0) return [];
	return db.query.releases.findMany({
		where: and(
			or(
				inArray(releases.runtimeTargetId, targetIds),
				and(
					inArray(releases.previousRuntimeTargetId, targetIds),
					isNotNull(releases.runtimeRelocationState),
				),
			),
			or(
				inArray(releases.status, [
					"queued",
					"deploying",
					"checking",
					"ready",
					"failed",
				]),
				isNotNull(releases.runtimeRelocationState),
			),
		),
		columns: {
			releaseId: true,
			organizationId: true,
			projectId: true,
			status: true,
			runtimeTargetId: true,
			runtimePlacementId: true,
			previousRuntimeTargetId: true,
			previousRuntimePlacementId: true,
			runtimeRelocationId: true,
			runtimeRelocationState: true,
		},
	});
};

const markRelocationFailure = async (
	releaseId: string,
	relocationId: string,
	error: unknown,
) => {
	await db
		.update(releases)
		.set({
			runtimeRelocationState: "failed",
			runtimeRelocationError: (error instanceof Error
				? error.message
				: String(error)
			).slice(0, 1_000),
		})
		.where(
			and(
				eq(releases.releaseId, releaseId),
				eq(releases.runtimeRelocationId, relocationId),
				inArray(releases.runtimeRelocationState, [
					"preparing",
					"draining_old",
					"failed",
				]),
			),
		);
};

const clearRelocation = async (input: {
	releaseId: string;
	relocationId: string;
}) => {
	const [cleared] = await db
		.update(releases)
		.set({
			previousRuntimeTargetId: null,
			previousRuntimePlacementId: null,
			runtimeRelocationId: null,
			runtimeRelocationState: null,
			runtimeRelocationError: null,
		})
		.where(
			and(
				eq(releases.releaseId, input.releaseId),
				eq(releases.runtimeRelocationId, input.relocationId),
				inArray(releases.runtimeRelocationState, ["draining_old", "failed"]),
			),
		)
		.returning({ releaseId: releases.releaseId });
	if (!cleared) throw new Error("Release relocation completion lost its claim");
};

const drainPreviousPlacement = async (
	release: {
		releaseId: string;
		runtimeRelocationId: string | null;
		previousRuntimeTargetId: string | null;
		previousRuntimePlacementId: string | null;
	},
	relocator: RuntimeReleaseRelocator,
) => {
	if (
		!release.runtimeRelocationId ||
		!release.previousRuntimeTargetId ||
		!release.previousRuntimePlacementId
	) {
		throw new Error("Release relocation checkpoint is incomplete");
	}
	const proof = await relocator.drainPrevious({
		relocationId: release.runtimeRelocationId,
		releaseId: release.releaseId,
		runtimeTargetId: release.previousRuntimeTargetId,
		runtimePlacementId: release.previousRuntimePlacementId,
	});
	if (proof.drained !== true || !proof.proofId.trim()) {
		throw new Error("Old runtime placement drain was not proven");
	}
	await clearRelocation({
		releaseId: release.releaseId,
		relocationId: release.runtimeRelocationId,
	});
};

export const reconcileRuntimeClusterDrain = async (
	runtimeClusterId: string,
	relocator?: RuntimeReleaseRelocator,
) => {
	const cluster = await db.query.runtimeClusters.findFirst({
		where: and(
			eq(runtimeClusters.runtimeClusterId, runtimeClusterId),
			isNull(runtimeClusters.deletedAt),
		),
	});
	if (!cluster) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Runtime cluster not found",
		});
	}
	if (cluster.drainState === "active") {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Runtime cluster is not draining",
		});
	}
	const targetIds = await targetIdsForCluster(runtimeClusterId);
	const activeLeases = await db.query.capacityLeases.findMany({
		where: and(
			eq(capacityLeases.runtimeClusterId, runtimeClusterId),
			inArray(capacityLeases.state, ["active", "releasing", "reconciling"]),
		),
		columns: { capacityLeaseId: true },
	});
	const initialReleases = await blockingReleases(targetIds);
	const projectIds = [
		...new Set(initialReleases.map((release) => release.projectId)),
	];
	const policies =
		projectIds.length === 0
			? []
			: await db.query.projectPlacementPolicies.findMany({
					where: inArray(projectPlacementPolicies.projectId, projectIds),
					columns: { projectId: true, pinToRegion: true },
				});
	const pinnedProjects = new Set(
		policies
			.filter((policy) => policy.pinToRegion)
			.map((policy) => policy.projectId),
	);
	const activeRelocator = relocator ?? registeredRuntimeReleaseRelocator;
	const pinnedReleaseIds: string[] = [];
	const relocatedReleaseIds: string[] = [];
	const failedReleaseIds: string[] = [];

	for (const release of initialReleases) {
		if (
			release.previousRuntimeTargetId &&
			targetIds.includes(release.previousRuntimeTargetId) &&
			release.runtimeRelocationState &&
			release.runtimeTargetId &&
			!targetIds.includes(release.runtimeTargetId)
		) {
			if (!activeRelocator) {
				failedReleaseIds.push(release.releaseId);
				continue;
			}
			try {
				await drainPreviousPlacement(release, activeRelocator);
				relocatedReleaseIds.push(release.releaseId);
			} catch (error) {
				if (release.runtimeRelocationId) {
					await markRelocationFailure(
						release.releaseId,
						release.runtimeRelocationId,
						error,
					);
				}
				failedReleaseIds.push(release.releaseId);
			}
			continue;
		}
		if (
			!release.runtimeTargetId ||
			!targetIds.includes(release.runtimeTargetId)
		) {
			failedReleaseIds.push(release.releaseId);
			continue;
		}
		if (release.status === "failed" || release.status !== "ready") {
			failedReleaseIds.push(release.releaseId);
			continue;
		}
		if (pinnedProjects.has(release.projectId)) {
			pinnedReleaseIds.push(release.releaseId);
			continue;
		}
		if (!release.runtimePlacementId) {
			failedReleaseIds.push(release.releaseId);
			continue;
		}
		if (!activeRelocator) {
			failedReleaseIds.push(release.releaseId);
			continue;
		}

		const relocationId = release.runtimeRelocationId ?? nanoid();
		try {
			if (!release.runtimeRelocationState) {
				const [claimed] = await db
					.update(releases)
					.set({
						previousRuntimeTargetId: release.runtimeTargetId,
						previousRuntimePlacementId: release.runtimePlacementId,
						runtimeRelocationId: relocationId,
						runtimeRelocationState: "preparing",
						runtimeRelocationError: null,
					})
					.where(
						and(
							eq(releases.releaseId, release.releaseId),
							eq(releases.runtimeTargetId, release.runtimeTargetId),
							eq(releases.runtimePlacementId, release.runtimePlacementId),
							isNull(releases.runtimeRelocationState),
						),
					)
					.returning({ releaseId: releases.releaseId });
				if (!claimed)
					throw new Error("Release changed before relocation started");
			}
			const prepared = await activeRelocator.prepare({
				relocationId,
				releaseId: release.releaseId,
				organizationId: release.organizationId,
				projectId: release.projectId,
				excludedRuntimeClusterId: runtimeClusterId,
				previousRuntimeTargetId: release.runtimeTargetId,
				previousRuntimePlacementId: release.runtimePlacementId,
			});
			if (
				prepared.placementHealth !== "healthy" ||
				prepared.trafficReady !== true ||
				prepared.aliasReady !== true ||
				!prepared.runtimePlacementId ||
				!prepared.readinessProof.trim()
			) {
				throw new Error("Relocator did not prove healthy traffic readiness");
			}
			if (targetIds.includes(prepared.runtimeTargetId)) {
				throw new Error("Relocator selected a target in the draining cluster");
			}
			const freshnessCutoff = new Date(
				Date.now() - CAPACITY_HEALTH_FRESHNESS_MS,
			);
			const target = await db.query.runtimeTargets.findFirst({
				where: and(
					eq(runtimeTargets.runtimeTargetId, prepared.runtimeTargetId),
					eq(runtimeTargets.health, "healthy"),
					gt(runtimeTargets.lastHeartbeatAt, freshnessCutoff),
					eq(runtimeTargets.drainState, "active"),
					isNull(runtimeTargets.deletedAt),
				),
			});
			const targetCluster = target
				? await db.query.runtimeClusters.findFirst({
						where: and(
							eq(runtimeClusters.runtimeClusterId, target.runtimeClusterId),
							eq(runtimeClusters.health, "healthy"),
							gt(runtimeClusters.lastHeartbeatAt, freshnessCutoff),
							eq(runtimeClusters.drainState, "active"),
							isNull(runtimeClusters.deletedAt),
						),
					})
				: null;
			if (
				!target ||
				!targetCluster ||
				targetCluster.runtimeClusterId === runtimeClusterId
			) {
				throw new Error("Relocation target is not fresh, healthy, and active");
			}
			const [moved] = await db
				.update(releases)
				.set({
					runtimeTargetId: prepared.runtimeTargetId,
					runtimePlacementId: prepared.runtimePlacementId,
					runtimeRelocationState: "draining_old",
					runtimeRelocationError: null,
				})
				.where(
					and(
						eq(releases.releaseId, release.releaseId),
						eq(releases.runtimeTargetId, release.runtimeTargetId),
						eq(releases.runtimePlacementId, release.runtimePlacementId),
						eq(releases.runtimeRelocationId, relocationId),
						inArray(releases.runtimeRelocationState, ["preparing", "failed"]),
					),
				)
				.returning({ releaseId: releases.releaseId });
			if (!moved) throw new Error("Release changed during relocation commit");
			await drainPreviousPlacement(
				{
					releaseId: release.releaseId,
					runtimeRelocationId: relocationId,
					previousRuntimeTargetId: release.runtimeTargetId,
					previousRuntimePlacementId: release.runtimePlacementId,
				},
				activeRelocator,
			);
			relocatedReleaseIds.push(release.releaseId);
		} catch (error) {
			await markRelocationFailure(release.releaseId, relocationId, error);
			failedReleaseIds.push(release.releaseId);
		}
	}

	const [remainingLeases, remainingReleases] = await Promise.all([
		db.query.capacityLeases.findMany({
			where: and(
				eq(capacityLeases.runtimeClusterId, runtimeClusterId),
				inArray(capacityLeases.state, ["active", "releasing", "reconciling"]),
			),
			columns: { capacityLeaseId: true },
		}),
		blockingReleases(targetIds),
	]);
	const canComplete =
		remainingLeases.length === 0 && remainingReleases.length === 0;
	if (canComplete && cluster.drainState !== "drained") {
		await db.transaction(async (transaction) => {
			await transaction
				.update(runtimeTargets)
				.set({ drainState: "drained", updatedAt: new Date() })
				.where(
					and(
						eq(runtimeTargets.runtimeClusterId, runtimeClusterId),
						isNull(runtimeTargets.deletedAt),
					),
				);
			const [completed] = await transaction
				.update(runtimeClusters)
				.set({ drainState: "drained", updatedAt: new Date() })
				.where(
					and(
						eq(runtimeClusters.runtimeClusterId, runtimeClusterId),
						eq(runtimeClusters.drainState, "draining"),
					),
				)
				.returning({ runtimeClusterId: runtimeClusters.runtimeClusterId });
			if (!completed) throw new Error("Runtime cluster drain state changed");
		});
	}
	return {
		complete: canComplete,
		reconciliationAvailable: Boolean(activeRelocator),
		activeLeaseIds: remainingLeases.map((lease) => lease.capacityLeaseId),
		pinnedReleaseIds: [...new Set(pinnedReleaseIds)].sort(),
		relocatedReleaseIds: [...new Set(relocatedReleaseIds)].sort(),
		failedReleaseIds: [
			...new Set([
				...failedReleaseIds,
				...remainingReleases
					.filter((release) => !pinnedReleaseIds.includes(release.releaseId))
					.map((release) => release.releaseId),
			]),
		].sort(),
	};
};

export const restoreRuntimeCluster = async (runtimeClusterId: string) =>
	db.transaction(async (transaction) => {
		const targets = await transaction.query.runtimeTargets.findMany({
			where: and(
				eq(runtimeTargets.runtimeClusterId, runtimeClusterId),
				isNull(runtimeTargets.deletedAt),
			),
			columns: { runtimeTargetId: true },
		});
		const targetIds = targets.map((target) => target.runtimeTargetId);
		if (targetIds.length > 0) {
			const relocation = await transaction.query.releases.findFirst({
				where: and(
					isNotNull(releases.runtimeRelocationState),
					or(
						inArray(releases.runtimeTargetId, targetIds),
						inArray(releases.previousRuntimeTargetId, targetIds),
					),
				),
				columns: { releaseId: true },
			});
			if (relocation) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"Runtime cluster has an in-progress relocation and requires explicit review",
				});
			}
		}
		const [cluster] = await transaction
			.update(runtimeClusters)
			.set({ drainState: "active", updatedAt: new Date() })
			.where(
				and(
					eq(runtimeClusters.runtimeClusterId, runtimeClusterId),
					inArray(runtimeClusters.drainState, ["draining", "drained"]),
					isNull(runtimeClusters.deletedAt),
				),
			)
			.returning();
		if (!cluster) {
			const existing = await transaction.query.runtimeClusters.findFirst({
				where: and(
					eq(runtimeClusters.runtimeClusterId, runtimeClusterId),
					isNull(runtimeClusters.deletedAt),
				),
			});
			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Runtime cluster not found",
				});
			}
			return existing;
		}
		await transaction
			.update(runtimeTargets)
			.set({ drainState: "active", updatedAt: new Date() })
			.where(
				and(
					eq(runtimeTargets.runtimeClusterId, runtimeClusterId),
					isNull(runtimeTargets.deletedAt),
				),
			);
		return cluster;
	});
