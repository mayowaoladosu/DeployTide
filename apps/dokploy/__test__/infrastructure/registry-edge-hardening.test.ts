import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
	type AdapterExecutionContext,
	DockerContentRegistryProvider,
	isRegistryArtifactSizeAllowed,
	MAX_REGISTRY_ARTIFACT_BYTES,
	TraefikEdgeProvider,
} from "@dokploy/server";
import { describe, expect, it, vi } from "vitest";

type RegistryDocker = NonNullable<
	ConstructorParameters<typeof DockerContentRegistryProvider>[0]
>;

const exactDigest = (content: Buffer | string) =>
	`sha256:${createHash("sha256").update(content).digest("hex")}`;
const validImageDigest = `sha256:${"a".repeat(64)}`;

const executionContext = (
	correlationId = "registry-edge-hardening",
): AdapterExecutionContext => ({
	correlationId,
	fencingToken: 51,
	providerId: "provider-hardening",
	regionCode: "east-us",
});

const consumeStream = async (stream: NodeJS.ReadableStream) => {
	const chunks: Buffer[] = [];
	for await (const chunk of stream as Readable) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
};

const mockRegistryDocker = (input?: {
	beforeLoadRead?: () => Promise<void>;
	holdProgress?: boolean;
	imageId?: string;
	progressError?: Error;
}) => {
	let loaded = Buffer.alloc(0);
	let markProgressStarted: (() => void) | undefined;
	const progressStarted = new Promise<void>((resolve) => {
		markProgressStarted = resolve;
	});
	const inspect = vi.fn(async () => ({
		Id: input?.imageId ?? validImageDigest,
	}));
	const remove = vi.fn(async () => undefined);
	const getImage = vi.fn(() => ({ inspect, remove }));
	const loadImage = vi.fn(async (stream: NodeJS.ReadableStream) => {
		await input?.beforeLoadRead?.();
		loaded = await consumeStream(stream);
		return Readable.from([]);
	});
	const followProgress = vi.fn(
		(
			_stream: NodeJS.ReadableStream,
			callback: (error?: Error | null) => void,
		) => {
			if (input?.holdProgress) {
				markProgressStarted?.();
				return;
			}
			callback(input?.progressError ?? null);
		},
	);
	const docker = {
		getImage,
		loadImage,
		modem: { followProgress },
		version: vi.fn(async () => ({ Version: "test" })),
	} as unknown as RegistryDocker;
	return {
		docker,
		followProgress,
		getImage,
		inspect,
		loadImage,
		loaded: () => loaded,
		progressStarted,
		remove,
	};
};

const registryTemporaryDirectories = async () =>
	(await readdir(tmpdir(), { withFileTypes: true }))
		.filter(
			(entry) =>
				entry.isDirectory() && entry.name.startsWith("deploytide-registry-"),
		)
		.map((entry) => entry.name)
		.sort();

const publishOperation = (artifactPath: string, digest: string) => ({
	kind: "artifact.publish" as const,
	artifactPath,
	expectedContentDigest: digest,
	imageName: "deploytide/hardening:proof",
});

const publishRoute = (aliasId: string, expectedVersion: number) => ({
	kind: "route.publish" as const,
	aliasId,
	expectedVersion,
	hostname: `${aliasId}.deploytide.test`,
	runtimeEndpoint: "http://runtime.internal:8080",
});

const temporaryResidue = async (directory: string) =>
	(await readdir(directory)).filter(
		(name) => name.endsWith(".tmp") || name.endsWith(".lock"),
	);

describe("Docker content registry hardening", () => {
	it("loads the immutable staged bytes when the source mutates after staging", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-registry-test-"),
		);
		const artifactPath = path.join(root, "image.tar");
		const original = Buffer.from("original registry artifact\n".repeat(128));
		const mutated = Buffer.from("mutated source after staging\n".repeat(128));
		try {
			await writeFile(artifactPath, original);
			const mock = mockRegistryDocker({
				beforeLoadRead: async () => writeFile(artifactPath, mutated),
			});
			const registry = new DockerContentRegistryProvider(mock.docker);
			const result = await registry.execute(
				executionContext(),
				publishOperation(artifactPath, exactDigest(original)),
			);
			expect(result).toEqual({
				kind: "artifact.published",
				imageReference: "deploytide/hardening:proof",
				imageDigest: validImageDigest,
			});
			expect(mock.loaded()).toEqual(original);
			expect(exactDigest(mock.loaded())).toBe(exactDigest(original));
			expect(await readFile(artifactPath)).toEqual(mutated);
			expect(mock.loadImage).toHaveBeenCalledOnce();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a source mutation against the expected content digest", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-registry-mutation-"),
		);
		const artifactPath = path.join(root, "image.tar");
		try {
			const original = Buffer.from("original artifact");
			await writeFile(artifactPath, original);
			const digest = exactDigest(original);
			await writeFile(artifactPath, "mutated artifact");
			const mock = mockRegistryDocker();
			const registry = new DockerContentRegistryProvider(mock.docker);
			await expect(
				registry.execute(
					executionContext(),
					publishOperation(artifactPath, digest),
				),
			).rejects.toThrow("Registry artifact publication failed");
			expect(mock.loadImage).not.toHaveBeenCalled();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects symbolic-link artifacts before Docker is called", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-registry-link-"),
		);
		const target = path.join(root, "target.tar");
		const link = path.join(root, "link.tar");
		try {
			await writeFile(target, "artifact");
			await symlink(target, link, "file");
			const mock = mockRegistryDocker();
			const registry = new DockerContentRegistryProvider(mock.docker);
			await expect(
				registry.execute(
					executionContext(),
					publishOperation(link, exactDigest("artifact")),
				),
			).rejects.toThrow("Registry artifact publication failed");
			expect(mock.loadImage).not.toHaveBeenCalled();
			expect(mock.getImage).not.toHaveBeenCalled();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a declared artifact larger than the 2 GiB bound", () => {
		expect(
			isRegistryArtifactSizeAllowed(BigInt(MAX_REGISTRY_ARTIFACT_BYTES)),
		).toBe(true);
		expect(
			isRegistryArtifactSizeAllowed(BigInt(MAX_REGISTRY_ARTIFACT_BYTES) + 1n),
		).toBe(false);
	});

	it.each([
		"sha256:short",
		`sha256:${"A".repeat(64)}`,
		`SHA256:${"a".repeat(64)}`,
		`sha256:${"a".repeat(64)}extra`,
	])("rejects non-exact inspect digest %s", async (imageId) => {
		const mock = mockRegistryDocker({ imageId });
		const registry = new DockerContentRegistryProvider(mock.docker);
		await expect(
			registry.execute(executionContext(), {
				kind: "artifact.resolve",
				imageReference: "deploytide/hardening:proof",
			}),
		).rejects.toThrow(/exact content digest/i);
	});

	it("uses a generic publication error and removes staging after Docker failure", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-registry-fail-"),
		);
		const artifactPath = path.join(root, "private-artifact.tar");
		const content = Buffer.from("registry failure proof");
		const before = await registryTemporaryDirectories();
		try {
			await writeFile(artifactPath, content);
			const mock = mockRegistryDocker({
				progressError: new Error(`Docker rejected ${artifactPath}`),
			});
			const registry = new DockerContentRegistryProvider(mock.docker);
			let failure: unknown;
			try {
				await registry.execute(
					executionContext(),
					publishOperation(artifactPath, exactDigest(content)),
				);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toBe(
				"Registry artifact publication failed",
			);
			expect((failure as Error).message).not.toContain(artifactPath);
			expect(await registryTemporaryDirectories()).toEqual(before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("cleans staging when the loaded image exposes an invalid digest", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "deploytide-registry-id-"));
		const artifactPath = path.join(root, "image.tar");
		const content = Buffer.from("registry inspect proof");
		const before = await registryTemporaryDirectories();
		try {
			await writeFile(artifactPath, content);
			const mock = mockRegistryDocker({ imageId: "sha256:partial" });
			const registry = new DockerContentRegistryProvider(mock.docker);
			await expect(
				registry.execute(
					executionContext(),
					publishOperation(artifactPath, exactDigest(content)),
				),
			).rejects.toThrow("Registry artifact publication failed");
			expect(await registryTemporaryDirectories()).toEqual(before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("aborts Docker progress and removes the private staged tree", async () => {
		const root = await mkdtemp(
			path.join(tmpdir(), "deploytide-registry-abort-"),
		);
		const artifactPath = path.join(root, "image.tar");
		const content = Buffer.from("registry abort proof");
		const before = await registryTemporaryDirectories();
		try {
			await writeFile(artifactPath, content);
			const mock = mockRegistryDocker({ holdProgress: true });
			const registry = new DockerContentRegistryProvider(mock.docker);
			const controller = new AbortController();
			const execution = registry.execute(
				{ ...executionContext(), signal: controller.signal },
				publishOperation(artifactPath, exactDigest(content)),
			);
			await mock.progressStarted;
			controller.abort();
			await expect(execution).rejects.toThrow(
				"Registry artifact publication failed",
			);
			expect(await registryTemporaryDirectories()).toEqual(before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("bounds resolve and delete references before Docker access", async () => {
		const mock = mockRegistryDocker();
		const registry = new DockerContentRegistryProvider(mock.docker);
		await expect(
			registry.execute(executionContext(), {
				kind: "artifact.resolve",
				imageReference: "../outside",
			}),
		).rejects.toThrow(/reference is invalid/i);
		await expect(
			registry.execute(executionContext(), {
				kind: "artifact.delete",
				imageReference: `deploytide/${"x".repeat(400)}`,
			}),
		).rejects.toThrow(/reference is invalid/i);
		expect(mock.getImage).not.toHaveBeenCalled();
	});
});

describe("Traefik file edge hardening", () => {
	it("allows exactly one concurrent caller to win the same CAS version", async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), "deploytide-edge-cas-"),
		);
		try {
			const edge = new TraefikEdgeProvider(directory);
			const calls = await Promise.allSettled([
				edge.execute(executionContext("edge-cas-one"), publishRoute("cas", 0)),
				edge.execute(executionContext("edge-cas-two"), publishRoute("cas", 0)),
			]);
			expect(calls.filter((call) => call.status === "fulfilled")).toHaveLength(
				1,
			);
			expect(calls.filter((call) => call.status === "rejected")).toHaveLength(
				1,
			);
			const state = JSON.parse(
				await readFile(path.join(directory, "cas.state.json"), "utf8"),
			) as { version: number };
			expect(state.version).toBe(1);
			expect(await temporaryResidue(directory)).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("fails closed without breaking a stale alias lock", async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), "deploytide-edge-lock-"),
		);
		const lock = path.join(directory, "stale.lock");
		try {
			await mkdir(lock, { mode: 0o700 });
			const edge = new TraefikEdgeProvider(directory);
			await expect(
				edge.execute(
					executionContext("edge-stale-lock"),
					publishRoute("stale", 0),
				),
			).rejects.toThrow(/already in progress/i);
			expect((await lstat(lock)).isDirectory()).toBe(true);
			expect(await readdir(directory)).toEqual(["stale.lock"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects paired-file version mismatch, malformed config, and half-state", async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), "deploytide-edge-corrupt-"),
		);
		try {
			const edge = new TraefikEdgeProvider(directory);
			await edge.execute(
				executionContext("edge-corrupt-seed"),
				publishRoute("mismatch", 0),
			);
			await writeFile(
				path.join(directory, "mismatch.state.json"),
				JSON.stringify({
					hostname: "mismatch.deploytide.test",
					status: "published",
					version: 2,
				}),
			);
			await expect(
				edge.execute(
					executionContext("edge-corrupt-mismatch"),
					publishRoute("mismatch", 1),
				),
			).rejects.toThrow(/state is corrupt/i);

			await writeFile(path.join(directory, "malformed.yml"), "not traefik\n");
			await writeFile(
				path.join(directory, "malformed.state.json"),
				JSON.stringify({
					hostname: "malformed.deploytide.test",
					status: "published",
					version: 1,
				}),
			);
			await expect(
				edge.execute(
					executionContext("edge-corrupt-config"),
					publishRoute("malformed", 1),
				),
			).rejects.toThrow(/state is corrupt/i);

			await writeFile(
				path.join(directory, "half.state.json"),
				JSON.stringify({
					hostname: "half.deploytide.test",
					status: "withdrawn",
					version: 1,
				}),
			);
			await expect(
				edge.execute(
					executionContext("edge-corrupt-half"),
					publishRoute("half", 1),
				),
			).rejects.toThrow(/state is corrupt/i);
			expect(await temporaryResidue(directory)).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps publish and withdrawal config/state versions in parity", async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), "deploytide-edge-parity-"),
		);
		try {
			const edge = new TraefikEdgeProvider(directory);
			await expect(
				edge.execute(
					executionContext("edge-parity-publish"),
					publishRoute("parity", 0),
				),
			).resolves.toEqual({ kind: "route.published", version: 1 });
			const publishedConfig = await readFile(
				path.join(directory, "parity.yml"),
				"utf8",
			);
			const publishedState = JSON.parse(
				await readFile(path.join(directory, "parity.state.json"), "utf8"),
			) as { hostname: string; status: string; version: number };
			expect(publishedConfig).toContain("# deploytide-edge-version: 1");
			expect(publishedConfig).toContain("runtime.internal:8080");
			expect(publishedState).toEqual({
				hostname: "parity.deploytide.test",
				status: "published",
				version: 1,
			});

			await expect(
				edge.execute(executionContext("edge-parity-withdraw"), {
					kind: "route.withdraw",
					aliasId: "parity",
					expectedVersion: 1,
					hostname: "parity.deploytide.test",
				}),
			).resolves.toEqual({ kind: "route.withdrawn", version: 2 });
			const withdrawnConfig = await readFile(
				path.join(directory, "parity.yml"),
				"utf8",
			);
			const withdrawnState = JSON.parse(
				await readFile(path.join(directory, "parity.state.json"), "utf8"),
			) as { hostname: string; status: string; version: number };
			expect(withdrawnConfig).toContain("# deploytide-edge-version: 2");
			expect(withdrawnConfig).toContain("routers: {}");
			expect(withdrawnConfig).toContain("services: {}");
			expect(withdrawnConfig).not.toContain("runtime.internal");
			expect(withdrawnState).toEqual({
				hostname: "parity.deploytide.test",
				status: "withdrawn",
				version: 2,
			});
			expect(await temporaryResidue(directory)).toEqual([]);

			if (process.platform !== "win32") {
				expect(
					(await lstat(path.join(directory, "parity.yml"))).mode & 0o777,
				).toBe(0o600);
				expect(
					(await lstat(path.join(directory, "parity.state.json"))).mode & 0o777,
				).toBe(0o600);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects unsafe correlation IDs without creating path residue", async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), "deploytide-edge-correlation-"),
		);
		try {
			const edge = new TraefikEdgeProvider(directory);
			await expect(
				edge.execute(executionContext("../unsafe"), publishRoute("safe", 0)),
			).rejects.toThrow(/identity is invalid/i);
			expect(await readdir(directory)).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
