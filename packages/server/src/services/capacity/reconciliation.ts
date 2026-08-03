import type Dockerode from "dockerode";
import { and, desc, eq } from "drizzle-orm";
import { docker } from "../../constants";
import { db } from "../../db";
import { buildPools, operatorJobAttempts } from "../../db/schema";
import {
	type BuildCapacityReconciler,
	defaultCapacityReconciliationRegistry,
	type RuntimeCapacityReconciler,
	reconcileExpiredCapacityLeases,
	reconcileExpiredOperationClaims,
} from "./leases";

const RECONCILIATION_INTERVAL_MS = 30_000;
const RECONCILIATION_BATCH_SIZE = 100;

const isNotFound = (error: unknown) =>
	(error as { statusCode?: number }).statusCode === 404;

const buildLeaseFilters = (capacityLeaseId: string) => ({
	label: [
		`com.deploytide.lease=${capacityLeaseId}`,
		"com.deploytide.plane=build",
	],
});

/**
 * Removes only resources carrying both the exact capacity lease label and the
 * build-plane label, then proves that a second Docker scan is empty.
 */
export type BuildPoolCleanupScopeLookup = (
	buildPoolId: string,
) => Promise<string | null>;

const findBuildPoolCleanupScope: BuildPoolCleanupScopeLookup = async (
	buildPoolId,
) => {
	const pool = await db.query.buildPools.findFirst({
		where: eq(buildPools.buildPoolId, buildPoolId),
		columns: { endpointReference: true },
	});
	return pool?.endpointReference ?? null;
};

export const createDockerBuildCapacityReconciler =
	(
		client: Dockerode,
		lookupPoolScope: BuildPoolCleanupScopeLookup = findBuildPoolCleanupScope,
	): BuildCapacityReconciler =>
	async ({ lease, now }) => {
		if (!lease.buildPoolId) {
			return { status: "pending", reason: "Build lease has no pool identity" };
		}
		const scope = await lookupPoolScope(lease.buildPoolId);
		if (!scope?.startsWith("local-docker:")) {
			return {
				status: "pending",
				reason: "Build pool requires its registered regional cleanup adapter",
			};
		}
		const filters = buildLeaseFilters(lease.capacityLeaseId);
		const containers = await client.listContainers({ all: true, filters });
		for (const container of containers) {
			await client
				.getContainer(container.Id)
				.remove({ force: true, v: true })
				.catch((error) => {
					if (!isNotFound(error)) throw error;
				});
		}

		const networks = await client.listNetworks({ filters });
		for (const network of networks) {
			await client
				.getNetwork(network.Id)
				.remove()
				.catch((error) => {
					if (!isNotFound(error)) throw error;
				});
		}

		const volumes = await client.listVolumes({ filters });
		for (const volume of volumes.Volumes ?? []) {
			await client
				.getVolume(volume.Name)
				.remove({ force: true })
				.catch((error) => {
					if (!isNotFound(error)) throw error;
				});
		}

		const [remainingContainers, remainingNetworks, remainingVolumes] =
			await Promise.all([
				client.listContainers({ all: true, filters }),
				client.listNetworks({ filters }),
				client.listVolumes({ filters }),
			]);
		return {
			status: "clean",
			proofId: `docker-label-scan:${lease.capacityLeaseId}:${now.toISOString()}`,
			residue: {
				workers: remainingContainers.filter(
					(container) =>
						container.Labels?.["com.deploytide.ephemeral"] === "true",
				).length,
				containers: remainingContainers.length,
				networks: remainingNetworks.length,
				volumes: (remainingVolumes.Volumes ?? []).length,
			},
		};
	};

export type RuntimeDrainProofLookup = (input: {
	capacityLeaseId: string;
	fencingToken: number;
	releaseId: string;
}) => Promise<string | null>;

const findRuntimeDrainProof: RuntimeDrainProofLookup = async (input) => {
	const attempt = await db.query.operatorJobAttempts.findFirst({
		where: and(
			eq(operatorJobAttempts.capacityLeaseId, input.capacityLeaseId),
			eq(operatorJobAttempts.fencingToken, input.fencingToken),
			eq(operatorJobAttempts.kind, "release_drain"),
			eq(operatorJobAttempts.status, "succeeded"),
		),
		orderBy: desc(operatorJobAttempts.completedAt),
		columns: {
			operatorJobAttemptId: true,
			request: true,
			result: true,
		},
	});
	if (
		attempt?.request.releaseId !== input.releaseId ||
		attempt.result?.drained !== true
	) {
		return null;
	}
	return attempt.operatorJobAttemptId;
};

/**
 * Runtime capacity fails closed until a successful typed controller drain
 * result proves that the placement is gone. Missing database placement state
 * is not sufficient evidence because a remote create result may have been lost.
 */
export const createRuntimeCapacityReconciler =
	(
		lookupDrainProof: RuntimeDrainProofLookup = findRuntimeDrainProof,
	): RuntimeCapacityReconciler =>
	async ({ lease, release }) => {
		if (!release?.runtimePlacementId) {
			return {
				status: "pending",
				reason:
					"Runtime placement absence has not been proven by its controller",
			};
		}
		const proof = await lookupDrainProof({
			capacityLeaseId: lease.capacityLeaseId,
			fencingToken: lease.fencingToken,
			releaseId: release.releaseId,
		});
		if (proof) {
			return {
				status: "clean",
				proofId: `controller-drain:${proof}`,
				placementDrained: true,
			};
		}
		return {
			status: "pending",
			reason:
				"Runtime placement requires a successful typed controller drain proof",
		};
	};

let defaultsConfigured = false;

export const configureDefaultCapacityReconcilers = () => {
	if (defaultsConfigured) return;
	defaultCapacityReconciliationRegistry
		.registerBuild(createDockerBuildCapacityReconciler(docker))
		.registerRuntime(createRuntimeCapacityReconciler());
	defaultsConfigured = true;
};

export const runCapacityReconciliationPass = async () => {
	configureDefaultCapacityReconcilers();
	const capacity = await reconcileExpiredCapacityLeases({
		limit: RECONCILIATION_BATCH_SIZE,
	});
	const operations = await reconcileExpiredOperationClaims(
		RECONCILIATION_BATCH_SIZE,
	);
	return { capacity, operations };
};

interface CapacityReconciliationLoopState {
	timer: NodeJS.Timeout;
	running: boolean;
}

const globalForCapacityReconciliation = globalThis as typeof globalThis & {
	__deploytideCapacityReconciliation?: CapacityReconciliationLoopState;
};

export const startCapacityReconciliationLoop = () => {
	configureDefaultCapacityReconcilers();
	if (globalForCapacityReconciliation.__deploytideCapacityReconciliation) {
		return;
	}
	const state: CapacityReconciliationLoopState = {
		running: false,
		timer: setInterval(() => {
			if (state.running) return;
			state.running = true;
			void runCapacityReconciliationPass()
				.then(({ capacity, operations }) => {
					if (capacity.examined > 0 || operations > 0) {
						console.info("Capacity reconciliation completed", {
							examined: capacity.examined,
							recovered: capacity.recovered.length,
							pending: capacity.pending.length,
							failed: capacity.failed.length,
							operations,
						});
					}
				})
				.catch(() => {
					console.error("Capacity reconciliation pass failed");
				})
				.finally(() => {
					state.running = false;
				});
		}, RECONCILIATION_INTERVAL_MS),
	};
	state.timer.unref();
	globalForCapacityReconciliation.__deploytideCapacityReconciliation = state;
	void runCapacityReconciliationPass().catch(() => {
		console.error("Initial capacity reconciliation pass failed");
	});
};
