import {
	createDockerBuildCapacityReconciler,
	createRuntimeCapacityReconciler,
} from "@dokploy/server";
import { describe, expect, it, vi } from "vitest";

type BuildReconcilerDocker = Parameters<
	typeof createDockerBuildCapacityReconciler
>[0];

const context = (input: {
	kind: "build" | "runtime";
	runtimePlacementId?: string | null;
}) =>
	({
		lease: {
			capacityLeaseId: "lease-proof",
			buildPoolId: input.kind === "build" ? "pool-proof" : null,
			kind: input.kind,
			fencingToken: 17,
		},
		release:
			input.kind === "runtime"
				? {
						releaseId: "release-proof",
						runtimeTargetId: "target-proof",
						runtimePlacementId: input.runtimePlacementId ?? null,
						status: "ready",
					}
				: null,
		now: new Date("2026-08-03T00:00:00.000Z"),
	}) as never;

describe("default capacity reconciliation", () => {
	it("deletes and rescans only exact lease-labeled build resources", async () => {
		let containers = [
			{
				Id: "container-proof",
				Labels: {
					"com.deploytide.lease": "lease-proof",
					"com.deploytide.plane": "build",
					"com.deploytide.ephemeral": "true",
				},
			},
		];
		let networks = [{ Id: "network-proof" }];
		let volumes = [{ Name: "volume-proof" }];
		const listContainers = vi.fn(async () => containers);
		const listNetworks = vi.fn(async () => networks);
		const listVolumes = vi.fn(async () => ({ Volumes: volumes }));
		const docker = {
			listContainers,
			listNetworks,
			listVolumes,
			getContainer: vi.fn(() => ({
				remove: vi.fn(async () => {
					containers = [];
				}),
			})),
			getNetwork: vi.fn(() => ({
				remove: vi.fn(async () => {
					networks = [];
				}),
			})),
			getVolume: vi.fn(() => ({
				remove: vi.fn(async () => {
					volumes = [];
				}),
			})),
		} as unknown as BuildReconcilerDocker;

		const proof = await createDockerBuildCapacityReconciler(
			docker,
			async () => "local-docker:engine:build",
		)(context({ kind: "build" }));
		expect(proof).toMatchObject({
			status: "clean",
			residue: { workers: 0, containers: 0, networks: 0, volumes: 0 },
		});
		const expectedFilters = {
			label: ["com.deploytide.lease=lease-proof", "com.deploytide.plane=build"],
		};
		expect(listContainers).toHaveBeenCalledWith({
			all: true,
			filters: expectedFilters,
		});
		expect(listNetworks).toHaveBeenCalledWith({ filters: expectedFilters });
		expect(listVolumes).toHaveBeenCalledWith({ filters: expectedFilters });
	});

	it("keeps runtime counters reserved until a typed drain is proven", async () => {
		const lookup = vi.fn(async () => null);
		const pending = await createRuntimeCapacityReconciler(lookup)(
			context({ kind: "runtime", runtimePlacementId: "placement-proof" }),
		);
		expect(pending).toEqual({
			status: "pending",
			reason:
				"Runtime placement requires a successful typed controller drain proof",
		});
		expect(lookup).toHaveBeenCalledWith({
			capacityLeaseId: "lease-proof",
			fencingToken: 17,
			releaseId: "release-proof",
		});
	});

	it("requires controller proof even when placement state is missing", async () => {
		const absentLookup = vi.fn();
		await expect(
			createRuntimeCapacityReconciler(absentLookup)(
				context({ kind: "runtime", runtimePlacementId: null }),
			),
		).resolves.toEqual({
			status: "pending",
			reason: "Runtime placement absence has not been proven by its controller",
		});
		expect(absentLookup).not.toHaveBeenCalled();

		await expect(
			createRuntimeCapacityReconciler(async () => "attempt-proof")(
				context({ kind: "runtime", runtimePlacementId: "placement-proof" }),
			),
		).resolves.toEqual({
			status: "clean",
			proofId: "controller-drain:attempt-proof",
			placementDrained: true,
		});
	});
});
