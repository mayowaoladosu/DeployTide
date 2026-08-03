import { generateKeyPairSync } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
	type AdapterExecutionContext,
	type BuildProvider,
	type ControllerJobEnvelope,
	computeSourceSnapshotDigest,
	controllerJobResourceKey,
	controllerJobSigningInput,
	type EdgeProvider,
	encodeControllerJobPayload,
	InfrastructureAdapterRegistry,
	type InfrastructureProvider,
	LayerRailComputeInfrastructureProvider,
	type RegistryProvider,
	RootlessBuildKitProvider,
	type RuntimeProvider,
	resolveOperatorSecretReference,
	signControllerJob,
	type TelemetryProvider,
	TraefikEdgeProvider,
	verifyControllerJob,
} from "@dokploy/server";
import { afterEach, describe, expect, it, vi } from "vitest";

type BuildKitDocker = NonNullable<
	ConstructorParameters<typeof RootlessBuildKitProvider>[0]
>["docker"];

const context: AdapterExecutionContext = {
	correlationId: "provider-contract-test",
	fencingToken: 41,
	providerId: "provider-contract",
	regionCode: "east-us",
};

const probe = (adapterType: string) => ({
	adapterType,
	probe: async () => ({
		health: "healthy" as const,
		version: "1.0.0",
		capabilities: [adapterType],
	}),
});

const buildRequest = (input: {
	source: string;
	output: string;
	digest: string;
	timeoutMs?: number;
}) => ({
	kind: "build.execute" as const,
	buildId: "build-contract",
	leaseId: "lease-contract",
	sourceSnapshotPath: input.source,
	sourceSnapshotDigest: input.digest,
	outputDirectory: input.output,
	imageName: "deploytide/contract:proof",
	architecture: "amd64" as const,
	maxSourceBytes: 1024 * 1024,
	timeoutMs: input.timeoutMs,
});

const dockerError = (statusCode = 404) =>
	Object.assign(new Error("missing"), { statusCode });

const mockBuildDocker = (input?: {
	buildExitCode?: number;
	cleanupFails?: boolean;
	lateNetworkCreation?: boolean;
	logs?: Buffer;
	waitForever?: boolean;
}) => {
	type CreateOptions = {
		Image?: string;
		name?: string;
		Labels?: Record<string, string>;
		HostConfig?: Record<string, unknown>;
		User?: string;
		Cmd?: string[];
		Env?: string[];
	};
	const created: CreateOptions[] = [];
	const removed: string[] = [];
	const removedNetworks: string[] = [];
	const removedVolumes: string[] = [];
	const networkOptions: Record<string, unknown>[] = [];
	const volumeOptions: Record<string, unknown>[] = [];
	const containers = new Map<string, CreateOptions>();
	const networks = new Map<string, Record<string, unknown>>();
	const volumes = new Map<string, Record<string, unknown>>();
	let outputDirectory = "";
	let markNetworkCreationStarted: (() => void) | undefined;
	let releaseNetworkCreation: (() => void) | undefined;
	const networkCreationStarted = new Promise<void>((resolve) => {
		markNetworkCreationStarted = resolve;
	});
	const networkCreationGate = new Promise<void>((resolve) => {
		releaseNetworkCreation = resolve;
	});

	const inspectFor = (name: string) => {
		const options = containers.get(name);
		if (!options) return Promise.reject(dockerError());
		if (name.startsWith("dt-buildkit-") && !name.includes("-init-")) {
			const binds = (options.HostConfig?.Binds ?? []) as string[];
			const mountName = (destination: string) =>
				binds
					.find((bind) => bind.includes(`:${destination}:`))
					?.split(":", 1)[0] ?? "";
			return Promise.resolve({
				Config: {
					Image: options.Image,
					User: options.User,
					Cmd: options.Cmd,
					Env: options.Env,
					Labels: options.Labels,
					ExposedPorts: {},
				},
				HostConfig: {
					...options.HostConfig,
					IpcMode: "private",
					PidMode: "",
					RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
					UTSMode: "",
				},
				Mounts: [
					{
						Name: mountName("/home/user/.docker"),
						Destination: "/home/user/.docker",
						Type: "volume",
						RW: true,
					},
					{
						Name: mountName("/run/buildkit"),
						Destination: "/run/buildkit",
						Type: "volume",
						RW: true,
					},
					{
						Name: mountName("/home/user/.local/share/buildkit"),
						Destination: "/home/user/.local/share/buildkit",
						Type: "volume",
						RW: true,
					},
				],
				NetworkSettings: {
					Networks: { [String(options.HostConfig?.NetworkMode)]: {} },
					Ports: {},
				},
				AppArmorProfile: "unconfined",
				State: { Running: true, ExitCode: 0 },
			});
		}
		return Promise.resolve({
			Config: { Labels: options.Labels },
			State: { Running: true, ExitCode: 0 },
		});
	};

	const handleFor = (name: string) => ({
		start: vi.fn(async () => {
			if (name.startsWith("dt-buildctl-")) {
				const options = containers.get(name);
				const outputBind = (
					(options?.HostConfig?.Binds ?? []) as string[]
				).find((bind) => bind.endsWith(":/out:rw"));
				outputDirectory = outputBind?.slice(0, -":/out:rw".length) ?? "";
			}
		}),
		wait: vi.fn(async () => {
			if (name.startsWith("dt-buildctl-")) {
				if (input?.waitForever) return new Promise<never>(() => undefined);
				if ((input?.buildExitCode ?? 0) === 0) {
					await writeFile(path.join(outputDirectory, "image.tar"), "artifact", {
						mode: 0o666,
					});
				}
			}
			return {
				StatusCode: name.startsWith("dt-buildctl-")
					? (input?.buildExitCode ?? 0)
					: 0,
			};
		}),
		inspect: vi.fn(() => inspectFor(name)),
		remove: vi.fn(async () => {
			if (!containers.has(name)) throw dockerError();
			removed.push(name);
			containers.delete(name);
		}),
		logs: vi.fn(async () => input?.logs ?? Buffer.alloc(0)),
		exec: vi.fn(async () => ({
			start: async () => Readable.from([Buffer.from("ready")]),
			inspect: async () => ({ ExitCode: 0 }),
		})),
	});

	const docker = {
		modem: { followProgress: vi.fn((_stream, callback) => callback(null)) },
		getImage: vi.fn(() => ({
			inspect: vi.fn(async () => ({ Id: "sha256:image" })),
		})),
		pull: vi.fn(async () => Readable.from([])),
		createNetwork: vi.fn(async (options: Record<string, unknown>) => {
			if (input?.lateNetworkCreation) {
				markNetworkCreationStarted?.();
				await networkCreationGate;
			}
			networkOptions.push(options);
			networks.set(String(options.Name), options);
			return {};
		}),
		createVolume: vi.fn(async (options: Record<string, unknown>) => {
			volumeOptions.push(options);
			volumes.set(String(options.Name), options);
			return {};
		}),
		createContainer: vi.fn(async (options: CreateOptions) => {
			created.push(options);
			containers.set(String(options.name), options);
			return handleFor(String(options.name));
		}),
		getContainer: vi.fn((name: string) => handleFor(name)),
		getNetwork: vi.fn((name: string) => ({
			inspect: vi.fn(async () => {
				const options = networks.get(name);
				if (!options) throw dockerError();
				return {
					Attachable: options.Attachable,
					Driver: options.Driver,
					Ingress: options.Ingress,
					Internal: options.Internal,
					Labels: options.Labels,
					Options: options.Options,
					Scope: "local",
				};
			}),
			remove: vi.fn(async () => {
				if (input?.cleanupFails) throw new Error("mock cleanup failure");
				if (!networks.has(name)) throw dockerError();
				removedNetworks.push(name);
				networks.delete(name);
			}),
		})),
		getVolume: vi.fn((name: string) => ({
			inspect: vi.fn(async () => {
				const options = volumes.get(name);
				if (!options) throw dockerError();
				return { Labels: options.Labels };
			}),
			remove: vi.fn(async () => {
				if (!volumes.has(name)) throw dockerError();
				removedVolumes.push(name);
				volumes.delete(name);
			}),
		})),
	} as unknown as BuildKitDocker;
	return {
		docker,
		created,
		removed,
		removedNetworks,
		removedVolumes,
		networkOptions,
		networkCreationStarted,
		releaseNetworkCreation: () => releaseNetworkCreation?.(),
		volumeOptions,
	};
};

afterEach(() => vi.unstubAllEnvs());

describe("Phase 4 provider contracts", () => {
	it("requires the BuildKit worker image to be digest-pinned", () => {
		const mock = mockBuildDocker();
		expect(
			() =>
				new RootlessBuildKitProvider({
					docker: mock.docker,
					image: "moby/buildkit:latest",
				}),
		).toThrow(/pinned by digest/i);
		expect(
			() =>
				new RootlessBuildKitProvider({
					docker: mock.docker,
					image: `moby/buildkit@sha256:${"f".repeat(64)}`,
				}),
		).toThrow(/pinned by digest/i);
	});

	it("accepts an exact complete-tree digest and applies the hardened Docker contract", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-buildkit-contract-"),
		);
		const source = path.join(root, "source");
		const output = path.join(root, "output");
		try {
			await mkdir(path.join(source, "nested"), { recursive: true });
			await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n", {
				mode: 0o644,
			});
			await writeFile(
				path.join(source, "nested", "second.txt"),
				"complete tree\n",
				{
					mode: 0o640,
				},
			);
			const digest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
				.digest;
			const mock = mockBuildDocker();
			const provider = new RootlessBuildKitProvider({ docker: mock.docker });
			const result = await provider.execute(
				context,
				buildRequest({ source, output, digest }),
			);
			expect(result.sourceSnapshotDigest).toBe(digest);
			expect(result.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
			const labels = (component: string) => ({
				"com.deploytide.component": component,
				"com.deploytide.ephemeral": "true",
				"com.deploytide.lease": "lease-contract",
				"com.deploytide.managed-by": "deploytide",
				"com.deploytide.plane": "build",
			});
			expect(mock.networkOptions).toEqual([
				expect.objectContaining({
					Driver: "bridge",
					Internal: false,
					CheckDuplicate: true,
					Attachable: false,
					Ingress: false,
					Options: {
						"com.docker.network.bridge.enable_icc": "false",
						"com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
					},
					Labels: labels("network"),
				}),
			]);
			expect(mock.volumeOptions).toEqual([
				expect.objectContaining({ Labels: labels("state-volume") }),
				expect.objectContaining({ Labels: labels("config-volume") }),
				expect.objectContaining({ Labels: labels("socket-volume") }),
			]);
			const worker = mock.created.find(
				(options) => options.Labels?.["com.deploytide.component"] === "worker",
			);
			const client = mock.created.find(
				(options) => options.Labels?.["com.deploytide.component"] === "client",
			);
			expect(worker).toMatchObject({
				User: "1000:1000",
				Labels: labels("worker"),
				HostConfig: {
					Privileged: true,
					PidsLimit: 1024,
					Memory: 4 * 1024 * 1024 * 1024,
					NanoCpus: 4_000_000_000,
					OomKillDisable: false,
					PortBindings: {},
					PublishAllPorts: false,
					Devices: [],
					DeviceRequests: [],
					SecurityOpt: ["seccomp=unconfined", "apparmor=unconfined"],
				},
			});
			expect(
				(worker?.HostConfig?.Binds as string[]).some((bind) =>
					bind.includes("docker.sock"),
				),
			).toBe(false);
			expect(client).toMatchObject({
				User: "1000:1000",
				Labels: labels("client"),
				HostConfig: {
					Privileged: false,
					ReadonlyRootfs: true,
					CapDrop: ["ALL"],
					PidsLimit: 256,
					Memory: 1024 * 1024 * 1024,
					NanoCpus: 1_000_000_000,
					OomKillDisable: false,
					PortBindings: {},
					PublishAllPorts: false,
				},
			});
			const initializers = mock.created.filter(
				(options) =>
					options.Labels?.["com.deploytide.component"] === "initializer",
			);
			expect(initializers.length).toBeGreaterThanOrEqual(3);
			for (const initializer of initializers) {
				expect(initializer.Labels).toEqual(labels("initializer"));
				expect(initializer.HostConfig).toMatchObject({
					PidsLimit: 32,
					Memory: 128 * 1024 * 1024,
					NanoCpus: 500_000_000,
					OomKillDisable: false,
					Privileged: false,
				});
			}
			const outputMode = (await lstat(output)).mode & 0o777;
			const artifactMode = (await lstat(result.artifactPath)).mode & 0o777;
			if (process.platform !== "win32") {
				expect(outputMode).toBe(0o700);
				expect(artifactMode).toBe(0o600);
			}
			expect(mock.removedNetworks).toHaveLength(1);
			expect(mock.removedVolumes).toHaveLength(3);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lets a cleanup failure override an otherwise successful build", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-buildkit-scrub-"),
		);
		const source = path.join(root, "source");
		const output = path.join(root, "output");
		try {
			await mkdir(source);
			await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n");
			const digest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
				.digest;
			const mock = mockBuildDocker({ cleanupFails: true });
			const provider = new RootlessBuildKitProvider({ docker: mock.docker });
			await expect(
				provider.execute(context, buildRequest({ source, output, digest })),
			).rejects.toThrow("Ephemeral BuildKit worker could not be scrubbed");
			expect(
				mock.created.some(
					(entry) => entry.Labels?.["com.deploytide.component"] === "client",
				),
			).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("awaits live progress inspection before the build wait proceeds", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-buildkit-progress-"),
		);
		const source = path.join(root, "source");
		const output = path.join(root, "output");
		try {
			await mkdir(source);
			await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n");
			const digest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
				.digest;
			const mock = mockBuildDocker();
			let releaseInspection: (() => void) | undefined;
			const inspectionGate = new Promise<void>((resolve) => {
				releaseInspection = resolve;
			});
			let markInspectionStarted: (() => void) | undefined;
			const inspectionStarted = new Promise<void>((resolve) => {
				markInspectionStarted = resolve;
			});
			let executionSettled = false;
			const provider = new RootlessBuildKitProvider({
				docker: mock.docker,
				progress: async (stage) => {
					if (stage === "building-artifact") {
						markInspectionStarted?.();
						await inspectionGate;
					}
				},
			});
			const execution = provider
				.execute(context, buildRequest({ source, output, digest }))
				.finally(() => {
					executionSettled = true;
				});
			await inspectionStarted;
			expect(executionSettled).toBe(false);
			releaseInspection?.();
			await expect(execution).resolves.toMatchObject({ scrubbed: true });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("scrubs a network whose create resolves after the request deadline", async () => {
		vi.useFakeTimers();
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-buildkit-create-race-"),
		);
		const source = path.join(root, "source");
		const output = path.join(root, "output");
		try {
			await mkdir(source);
			await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n");
			const digest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
				.digest;
			const mock = mockBuildDocker({ lateNetworkCreation: true });
			const provider = new RootlessBuildKitProvider({ docker: mock.docker });
			const execution = provider.execute(
				context,
				buildRequest({ source, output, digest, timeoutMs: 10_000 }),
			);
			const rejection = expect(execution).rejects.toThrow(
				"Build execution exceeded its bounded deadline",
			);
			await mock.networkCreationStarted;
			await vi.advanceTimersByTimeAsync(10_001);
			mock.releaseNetworkCreation();
			await rejection;
			expect(mock.removedNetworks).toHaveLength(1);
		} finally {
			vi.useRealTimers();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("never returns source paths, secret values, or raw BuildKit logs", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-buildkit-redaction-"),
		);
		const source = path.join(root, "source");
		const output = path.join(root, "output");
		const secretPath = path.join(root, "secret");
		const secret = "build-secret-must-not-escape";
		try {
			await mkdir(source);
			await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n");
			await writeFile(secretPath, secret);
			const digest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
				.digest;
			const mock = mockBuildDocker({
				buildExitCode: 1,
				logs: Buffer.from(`failed at ${source}: token=${secret}`),
			});
			const provider = new RootlessBuildKitProvider({ docker: mock.docker });
			let failure: unknown;
			try {
				await provider.execute(context, {
					...buildRequest({ source, output, digest }),
					secretFiles: [{ id: "probe", path: secretPath }],
				});
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			const message = (failure as Error).message;
			expect(message).toBe("Rootless build failed");
			expect(message).not.toContain(source);
			expect(message).not.toContain(secret);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("removes an archive when post-build artifact verification fails", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-buildkit-artifact-failure-"),
		);
		const source = path.join(root, "source");
		const output = path.join(root, "output");
		try {
			await mkdir(source);
			await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n");
			const digest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
				.digest;
			const mock = mockBuildDocker();
			const provider = new RootlessBuildKitProvider({
				docker: mock.docker,
				progress: async (stage) => {
					if (stage === "verifying-artifact") {
						await writeFile(path.join(output, "image.tar"), "");
					}
				},
			});
			await expect(
				provider.execute(context, buildRequest({ source, output, digest })),
			).rejects.toThrow(/artifact exceeds/i);
			await expect(lstat(path.join(output, "image.tar"))).rejects.toMatchObject(
				{
					code: "ENOENT",
				},
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each(["mutation", "addition", "path-change"] as const)(
		"rejects a second-file %s before any Docker call",
		async (change) => {
			const root = await mkdtemp(
				path.join(tmpdir(), "deploytide-buildkit-digest-"),
			);
			const source = path.join(root, "source");
			const output = path.join(root, "output");
			try {
				await mkdir(source, { recursive: true });
				await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n");
				const second = path.join(source, "second.txt");
				await writeFile(second, "original\n");
				const digest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
					.digest;
				if (change === "mutation") await writeFile(second, "modified\n");
				if (change === "addition") {
					await writeFile(path.join(source, "third.txt"), "added\n");
				}
				if (change === "path-change") {
					await rename(second, path.join(source, "renamed.txt"));
				}
				const mock = mockBuildDocker();
				const provider = new RootlessBuildKitProvider({ docker: mock.docker });
				await expect(
					provider.execute(context, buildRequest({ source, output, digest })),
				).rejects.toThrow(/digest verification/i);
				expect(mock.networkOptions).toHaveLength(0);
				expect(mock.created).toHaveLength(0);
				expect(
					(mock.docker as unknown as { getImage: ReturnType<typeof vi.fn> })
						.getImage,
				).not.toHaveBeenCalled();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("rejects symlink output roots and invalid execution bounds before Docker", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-buildkit-paths-"),
		);
		const source = path.join(root, "source");
		const outputTarget = path.join(root, "output-target");
		const outputLink = path.join(root, "output-link");
		try {
			await mkdir(source);
			await mkdir(outputTarget);
			await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n");
			const digest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
				.digest;
			const mock = mockBuildDocker();
			const provider = new RootlessBuildKitProvider({ docker: mock.docker });
			await expect(
				provider.execute(context, {
					...buildRequest({ source, output: path.join(source, "out"), digest }),
					maxSourceBytes: 0,
				}),
			).rejects.toThrow(/byte limit/i);
			await expect(
				provider.execute(context, {
					...buildRequest({
						source,
						output: path.join(root, "too-large"),
						digest,
					}),
					maxSourceBytes: 1024 ** 3 + 1,
				}),
			).rejects.toThrow(/byte limit/i);
			await expect(
				provider.execute(context, {
					...buildRequest({ source, output: path.join(root, "out"), digest }),
					timeoutMs: 9_999,
				}),
			).rejects.toThrow(/timeout/i);
			await expect(
				provider.execute(context, {
					...buildRequest({
						source,
						output: path.join(root, "too-slow"),
						digest,
					}),
					timeoutMs: 30 * 60 * 1_000 + 1,
				}),
			).rejects.toThrow(/timeout/i);
			await expect(
				provider.execute(
					context,
					buildRequest({ source, output: path.join(source, "out"), digest }),
				),
			).rejects.toThrow(/outside the source/i);
			if (process.platform !== "win32") {
				const { symlink } = await import("node:fs/promises");
				await symlink(outputTarget, outputLink, "dir");
				await expect(
					provider.execute(
						context,
						buildRequest({ source, output: outputLink, digest }),
					),
				).rejects.toThrow(/output root/i);
			}
			expect(mock.networkOptions).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("enforces secret count, size, and source containment before Docker", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-buildkit-secrets-"),
		);
		const source = path.join(root, "source");
		const output = path.join(root, "output");
		const oversizedSecret = path.join(root, "oversized-secret");
		try {
			await mkdir(source);
			await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n");
			const sourceSecret = path.join(source, "source-secret");
			await writeFile(sourceSecret, "inside-source");
			await writeFile(oversizedSecret, Buffer.alloc(64 * 1024 + 1));
			const digest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
				.digest;
			const mock = mockBuildDocker();
			const provider = new RootlessBuildKitProvider({ docker: mock.docker });
			await expect(
				provider.execute(context, {
					...buildRequest({ source, output, digest }),
					secretFiles: Array.from({ length: 33 }, (_, index) => ({
						id: `secret-${index}`,
						path: oversizedSecret,
					})),
				}),
			).rejects.toThrow(/secret count/i);
			await expect(
				provider.execute(context, {
					...buildRequest({ source, output, digest }),
					secretFiles: [{ id: "oversized", path: oversizedSecret }],
				}),
			).rejects.toThrow(/secret file exceeds/i);
			await expect(
				provider.execute(context, {
					...buildRequest({ source, output, digest }),
					secretFiles: [{ id: "inside", path: sourceSecret }],
				}),
			).rejects.toThrow(/outside the source/i);
			expect(mock.networkOptions).toHaveLength(0);
			expect(mock.created).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("bounds build arguments before Docker", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-buildkit-args-"),
		);
		const source = path.join(root, "source");
		const output = path.join(root, "output");
		try {
			await mkdir(source);
			await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n");
			const digest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
				.digest;
			const mock = mockBuildDocker();
			const provider = new RootlessBuildKitProvider({ docker: mock.docker });
			await expect(
				provider.execute(context, {
					...buildRequest({ source, output, digest }),
					buildArgs: { TOO_LARGE: "x".repeat(64 * 1024 + 1) },
				}),
			).rejects.toThrow(/arguments exceed/i);
			expect(mock.networkOptions).toHaveLength(0);
			expect(mock.created).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("aborts an unbounded client wait, forces cleanup, and emits a generic error", async () => {
		vi.useFakeTimers();
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-buildkit-timeout-"),
		);
		const source = path.join(root, "source");
		const output = path.join(root, "output");
		try {
			await mkdir(source);
			await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n");
			const digest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
				.digest;
			const mock = mockBuildDocker({ waitForever: true });
			let markBuildReached: (() => void) | undefined;
			const buildReached = new Promise<void>((resolve) => {
				markBuildReached = resolve;
			});
			const provider = new RootlessBuildKitProvider({
				docker: mock.docker,
				progress: async (stage) => {
					if (stage === "building-artifact") {
						await writeFile(path.join(output, "image.tar"), "partial");
						markBuildReached?.();
					}
				},
			});
			const execution = provider.execute(
				context,
				buildRequest({ source, output, digest, timeoutMs: 10_000 }),
			);
			const rejection = expect(execution).rejects.toThrow(
				"Build execution exceeded its bounded deadline",
			);
			await buildReached;
			await vi.advanceTimersByTimeAsync(10_001);
			await rejection;
			expect(mock.removed.some((name) => name.startsWith("dt-buildctl-"))).toBe(
				true,
			);
			expect(mock.removed.some((name) => name.startsWith("dt-buildkit-"))).toBe(
				true,
			);
			expect(mock.removedNetworks).toHaveLength(1);
			expect(mock.removedVolumes).toHaveLength(3);
			await expect(lstat(path.join(output, "image.tar"))).rejects.toMatchObject(
				{
					code: "ENOENT",
				},
			);
		} finally {
			vi.useRealTimers();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("replaces all six adapters without changing the caller contract", async () => {
		const registry = new InfrastructureAdapterRegistry()
			.register("infrastructure", {
				...probe("infra-a"),
				execute: async () => ({
					kind: "capacity.deprovisioned" as const,
				}),
			} satisfies InfrastructureProvider)
			.register("build", {
				...probe("build-a"),
				execute: async () => ({
					kind: "build.completed" as const,
					artifactPath: "artifact",
					artifactDigest: "sha256:artifact",
					workerReference: "worker",
					builderVersion: "1",
					sourceSnapshotDigest: "sha256:source",
					scrubbed: true,
				}),
			} satisfies BuildProvider)
			.register("runtime", {
				...probe("runtime-a"),
				execute: async () => ({
					kind: "cluster.health" as const,
					health: "healthy" as const,
					version: "1",
				}),
			} satisfies RuntimeProvider)
			.register("registry", {
				...probe("registry-a"),
				execute: async () => ({ kind: "artifact.deleted" as const }),
			} satisfies RegistryProvider)
			.register("edge", {
				...probe("edge-a"),
				execute: async () => ({ kind: "route.withdrawn" as const, version: 1 }),
			} satisfies EdgeProvider)
			.register("telemetry", {
				...probe("telemetry-a"),
				execute: async () => ({ kind: "telemetry.logs" as const, lines: [] }),
			} satisfies TelemetryProvider);
		const callSite = async () =>
			Promise.all(
				registry
					.list()
					.map(({ kind, adapterType }) =>
						registry.resolve(kind, adapterType).probe(context),
					),
			);
		expect((await callSite()).map((result) => result.health)).toEqual([
			"healthy",
			"healthy",
			"healthy",
			"healthy",
			"healthy",
			"healthy",
		]);
		registry.replace("runtime", {
			...probe("runtime-a"),
			execute: async () => ({
				kind: "cluster.health" as const,
				health: "degraded" as const,
				version: "2",
			}),
		});
		expect(
			(await callSite()).find(
				(result) => result.capabilities[0] === "runtime-a",
			)?.version,
		).toBe("1.0.0");
	});

	it("keeps LayerRail credentials outside URLs, payloads, and results", async () => {
		vi.stubEnv("PHASE4_LAYERRAIL_TOKEN", "layerrail-private-token");
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SECRET_REFERENCES",
			JSON.stringify({ "layerrail-test": "env://PHASE4_LAYERRAIL_TOKEN" }),
		);
		const requests: Array<{ url: string; headers: Headers; body: string }> = [];
		const adapter = new LayerRailComputeInfrastructureProvider({
			endpoint: "https://compute.layerrail.test",
			secretId: "layerrail-test",
			resolver: async () => [{ address: "8.8.8.8", family: 4 }],
			fetch: async (input, init) => {
				requests.push({
					url: String(input),
					headers: new Headers(init?.headers),
					body: String(init?.body ?? ""),
				});
				return new Response(
					JSON.stringify({
						providerTargetReference: "lr-target-1",
						architecture: "amd64",
						version: "2026.8",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		});
		const result = await adapter.execute(context, {
			kind: "capacity.provision",
			requestId: "request-1",
			capacityKind: "runtime",
			architecture: "amd64",
			cpuMillis: 500,
			memoryMb: 512,
			cloudInit: "#cloud-config",
			labels: { plane: "runtime" },
		});
		expect(result.kind).toBe("capacity.provisioned");
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer layerrail-private-token",
		);
		expect(requests[0]?.headers.get("x-deploytide-fencing-token")).toBe("41");
		expect(
			`${requests[0]?.url}${requests[0]?.body}${JSON.stringify(result)}`,
		).not.toContain("layerrail-private-token");
	});

	it("accepts only configured opaque secret IDs, never browser-supplied env or file references", async () => {
		vi.stubEnv("PHASE4_OPAQUE_VALUE", "server-side-value");
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SECRET_REFERENCES",
			JSON.stringify({ "opaque-primary": "env://PHASE4_OPAQUE_VALUE" }),
		);
		await expect(
			resolveOperatorSecretReference("opaque-primary"),
		).resolves.toBe("server-side-value");
		await expect(
			resolveOperatorSecretReference("env://PHASE4_OPAQUE_VALUE"),
		).rejects.toThrow(/secret ID/i);
		await expect(
			resolveOperatorSecretReference("file:///etc/passwd"),
		).rejects.toThrow(/secret ID/i);
	});

	it("rejects private production resolution and DNS rebinding", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("DEPLOYTIDE_LAYERRAIL_ALLOWED_HOSTS", "compute.layerrail.test");
		vi.stubEnv("PHASE4_LAYERRAIL_TOKEN", "private-token");
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SECRET_REFERENCES",
			JSON.stringify({ "layerrail-test": "env://PHASE4_LAYERRAIL_TOKEN" }),
		);
		const blockedFetch = vi.fn();
		const privateAdapter = new LayerRailComputeInfrastructureProvider({
			endpoint: "https://compute.layerrail.test",
			secretId: "layerrail-test",
			resolver: async () => [{ address: "127.0.0.1", family: 4 }],
			fetch: blockedFetch,
		});
		await expect(privateAdapter.probe(context)).rejects.toThrow(
			/forbidden address/i,
		);
		expect(blockedFetch).not.toHaveBeenCalled();

		let resolutions = 0;
		const rebindingAdapter = new LayerRailComputeInfrastructureProvider({
			endpoint: "https://compute.layerrail.test",
			secretId: "layerrail-test",
			resolver: async () => [
				{
					address: resolutions++ === 0 ? "8.8.8.8" : "1.1.1.1",
					family: 4,
				},
			],
			fetch: async () =>
				new Response(
					JSON.stringify({
						health: "healthy",
						version: "1",
						capabilities: [],
					}),
					{ status: 200 },
				),
		});
		await expect(rebindingAdapter.probe(context)).rejects.toThrow(
			/DNS changed/i,
		);
	});

	it("rejects oversized provider responses", async () => {
		vi.stubEnv("PHASE4_LAYERRAIL_TOKEN", "private-token");
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SECRET_REFERENCES",
			JSON.stringify({ "layerrail-test": "env://PHASE4_LAYERRAIL_TOKEN" }),
		);
		const adapter = new LayerRailComputeInfrastructureProvider({
			endpoint: "https://compute.layerrail.test",
			secretId: "layerrail-test",
			resolver: async () => [{ address: "8.8.8.8", family: 4 }],
			fetch: async () =>
				new Response("{}", {
					status: 200,
					headers: { "Content-Length": String(300 * 1024) },
				}),
		});
		await expect(adapter.probe(context)).rejects.toThrow(/too large/i);
	});

	it("signs exact canonical payload bytes and rejects protocol forgery", () => {
		const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
			privateKeyEncoding: { format: "pem", type: "pkcs8" },
			publicKeyEncoding: { format: "pem", type: "spki" },
		});
		const now = new Date("2026-08-03T00:00:00.000Z");
		const request = {
			releaseId: "release-special",
			imageReference: "registry.example/release:test",
			imageDigest:
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			environment: {
				Z_LAST: "fish&chips <ok>",
				A_FIRST: "<tag>&東京",
			},
			containerPort: 8080,
			cpuMillis: 250,
			memoryMb: 512,
		};
		const payload = encodeControllerJobPayload("release_create", request);
		expect(Buffer.from(payload, "base64url").toString("utf8")).toBe(
			'{"containerPort":8080,"cpuMillis":250,"environment":{"A_FIRST":"<tag>&東京","Z_LAST":"fish&chips <ok>"},"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","imageReference":"registry.example/release:test","memoryMb":512,"releaseId":"release-special"}',
		);
		const resourceKey = controllerJobResourceKey(
			"release_create",
			request,
			"cluster-a",
		);
		expect(controllerJobResourceKey("cluster_health", {}, "cluster-a")).toBe(
			"cluster:cluster-a",
		);
		expect(
			controllerJobResourceKey("certificate_rotate", {}, "cluster-a"),
		).toBe("cluster:cluster-a");
		const envelope = signControllerJob(
			{
				version: "deploytide.runtime-controller.v1",
				attemptId: "attempt-1",
				clusterId: "cluster-a",
				sequence: 1,
				fencingToken: 9,
				resourceKey,
				kind: "release_create",
				issuedAt: now.toISOString(),
				expiresAt: new Date(now.getTime() + 60_000).toISOString(),
				payload,
			},
			privateKey,
		);
		expect(
			verifyControllerJob(envelope, publicKey, {
				expectedClusterId: "cluster-a",
				now,
			}),
		).toBe(true);
		expect(
			verifyControllerJob(
				{
					...envelope,
					payload: encodeControllerJobPayload("release_create", {
						...request,
						releaseId: "release-forged",
					}),
				},
				publicKey,
				{ expectedClusterId: "cluster-a", now },
			),
		).toBe(false);
		expect(
			verifyControllerJob(envelope, publicKey, {
				expectedClusterId: "cluster-b",
				now,
			}),
		).toBe(false);
		expect(
			verifyControllerJob({ ...envelope, payload: "not+base64" }, publicKey, {
				expectedClusterId: "cluster-a",
				now,
			}),
		).toBe(false);
		expect(() =>
			encodeControllerJobPayload("release_create", {
				...request,
				command: "sh -c whoami",
			}),
		).toThrow(/unknown/i);
		expect(
			verifyControllerJob(
				{ ...envelope, unexpected: true } as typeof envelope,
				publicKey,
				{ expectedClusterId: "cluster-a", now },
			),
		).toBe(false);
	});

	it("rejects non-empty runtime environments at the job persistence boundary", async () => {
		const schema = await readFile(
			new URL(
				"../../../../packages/server/src/db/schema/operator-job-attempt.ts",
				import.meta.url,
			),
			"utf8",
		);
		expect(schema).toContain("operator_job_release_environment_empty");
		expect(schema).toContain("'{}'::jsonb");
		expect(schema).toContain("operator_job_payload_bounds");
	});

	it("reproduces the fixed Go and TypeScript interoperability vector", async () => {
		const vector = JSON.parse(
			await readFile(
				new URL(
					"../../../runtime-controller/internal/protocol/testdata/controller-interop.json",
					import.meta.url,
				),
				"utf8",
			),
		) as {
			privateKeyPem: string;
			publicKeyPem: string;
			payloadObject: Record<string, unknown>;
			payloadJson: string;
			envelope: ControllerJobEnvelope;
			signingInputBase64url: string;
		};
		const payload = encodeControllerJobPayload(
			"release_create",
			vector.payloadObject,
		);
		expect(Buffer.from(payload, "base64url").toString("utf8")).toBe(
			vector.payloadJson,
		);
		expect(payload).toBe(vector.envelope.payload);
		const { signature: _signature, ...unsigned } = vector.envelope;
		expect(controllerJobSigningInput(unsigned).toString("base64url")).toBe(
			vector.signingInputBase64url,
		);
		expect(signControllerJob(unsigned, vector.privateKeyPem)).toEqual(
			vector.envelope,
		);
		expect(
			verifyControllerJob(vector.envelope, vector.publicKeyPem, {
				expectedClusterId: "cluster-interop",
				now: new Date("2026-08-03T00:00:30.000Z"),
			}),
		).toBe(true);
	});

	it("publishes edge routes with compare-and-swap versions", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "deploytide-edge-"));
		try {
			const edge = new TraefikEdgeProvider(directory);
			const first = await edge.execute(context, {
				kind: "route.publish",
				aliasId: "alias-a",
				hostname: "app.deploytide.test",
				runtimeEndpoint: "http://runtime.internal:8080",
				expectedVersion: 0,
			});
			expect(first).toEqual({ kind: "route.published", version: 1 });
			await expect(
				edge.execute(context, {
					kind: "route.withdraw",
					aliasId: "alias-a",
					hostname: "app.deploytide.test",
					expectedVersion: 0,
				}),
			).rejects.toThrow("changed");
			expect(
				await readFile(path.join(directory, "alias-a.yml"), "utf8"),
			).toContain("runtime.internal:8080");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
