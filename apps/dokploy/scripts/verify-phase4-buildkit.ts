import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { docker as sharedDocker } from "../../../packages/server/src/constants/index";
import { DockerContentRegistryProvider } from "../../../packages/server/src/infrastructure/adapters/docker-content-registry";
import { DockerRuntimeProvider } from "../../../packages/server/src/infrastructure/adapters/docker-runtime";
import {
	computeSourceSnapshotDigest,
	RootlessBuildKitProvider,
} from "../../../packages/server/src/infrastructure/adapters/rootless-buildkit";
import type { AdapterExecutionContext } from "../../../packages/server/src/infrastructure/contracts";

const docker = sharedDocker;
const runId = nanoid(10).toLowerCase();
const root = await mkdtemp(path.join(tmpdir(), "deploytide-phase4-"));
const source = path.join(root, "source");
const output = path.join(root, "output");
const secretPath = path.join(root, "build-secret");
const imageName = `deploytide-phase4-${runId}:proof`;
const releaseId = `phase4-${runId}`;
const leaseId = `lease-${runId}`;
const secret = `phase4-secret-${randomBytes(16).toString("hex")}`;
const context: AdapterExecutionContext = {
	correlationId: `phase4-e2e-${runId}`,
	fencingToken: Date.now(),
	providerId: "phase4-local-e2e",
	regionCode: "local-proof",
};
console.error("[phase4-buildkit] preparing-fixture");

const assert: (condition: unknown, message: string) => asserts condition = (
	condition,
	message,
) => {
	if (!condition) throw new Error(message);
};

const assertNoBuildResidue = async () => {
	const filters = { label: [`com.deploytide.lease=${leaseId}`] };
	const [containers, networks, volumes] = await Promise.all([
		docker.listContainers({ all: true, filters }),
		docker.listNetworks({ filters }),
		docker.listVolumes({ filters }),
	]);
	assert(
		containers.length === 0,
		"Ephemeral build containers survived their lease",
	);
	assert(networks.length === 0, "Ephemeral build network survived its lease");
	assert(
		(volumes.Volumes ?? []).length === 0,
		"Ephemeral build cache survived its lease",
	);
};

const deployTideLabels = (labels: Record<string, string> | undefined) =>
	Object.fromEntries(
		Object.entries(labels ?? {}).filter(([key]) =>
			key.startsWith("com.deploytide."),
		),
	);

const expectedLabels = (component: string) => ({
	"com.deploytide.component": component,
	"com.deploytide.ephemeral": "true",
	"com.deploytide.lease": leaseId,
	"com.deploytide.managed-by": "deploytide",
	"com.deploytide.plane": "build",
});

const assertExactLabels = (
	labels: Record<string, string> | undefined,
	component: string,
) =>
	assert(
		JSON.stringify(Object.entries(deployTideLabels(labels)).sort()) ===
			JSON.stringify(Object.entries(expectedLabels(component)).sort()),
		`Build ${component} labels differ from the provider contract`,
	);

const findBuildContainer = async (component: "client" | "worker") => {
	const matches = await docker.listContainers({
		all: true,
		filters: {
			label: [
				`com.deploytide.lease=${leaseId}`,
				`com.deploytide.component=${component}`,
			],
		},
	});
	assert(matches.length === 1, `Expected one ephemeral BuildKit ${component}`);
	const match = matches[0];
	assert(match, `Ephemeral BuildKit ${component} identity is missing`);
	return docker.getContainer(match.Id).inspect();
};

const inspectWorkerSecurity = async () => {
	const networks = await docker.listNetworks({
		filters: {
			label: [
				`com.deploytide.lease=${leaseId}`,
				"com.deploytide.component=network",
			],
		},
	});
	assert(networks.length === 1, "Expected one ephemeral build network");
	const network = networks[0];
	assert(network, "Ephemeral build network identity is missing");
	const inspectedNetwork = await docker.getNetwork(network.Id).inspect();
	assert(inspectedNetwork.Driver === "bridge", "Build network is not a bridge");
	assert(
		!inspectedNetwork.Internal,
		"Build network unexpectedly blocks package egress",
	);
	assert(!inspectedNetwork.Attachable, "Build network is attachable");
	assert(!inspectedNetwork.Ingress, "Build network is an ingress network");
	assert(
		inspectedNetwork.Options?.["com.docker.network.bridge.enable_icc"] ===
			"false",
		"Build network permits inter-container communication",
	);
	assert(
		inspectedNetwork.Options?.[
			"com.docker.network.bridge.host_binding_ipv4"
		] === "127.0.0.1",
		"Build network defaults do not bind to loopback",
	);
	assertExactLabels(inspectedNetwork.Labels, "network");

	const worker = await findBuildContainer("worker");
	assertExactLabels(worker.Config.Labels, "worker");
	assert(
		worker.Config.User === "1000:1000",
		"BuildKit worker is not uid/gid 1000",
	);
	assert(
		JSON.stringify(worker.Config.Cmd ?? []) ===
			JSON.stringify([
				"--addr",
				"unix:///run/buildkit/buildkitd.sock",
				"--oci-worker-no-process-sandbox",
				"--root",
				"/home/user/.local/share/buildkit",
			]),
		"BuildKit worker command changed",
	);
	assert(
		worker.HostConfig.Privileged,
		"BuildKit namespace bootstrap is not privileged",
	);
	assert(
		worker.HostConfig.IpcMode === "private",
		"BuildKit worker IPC namespace changed",
	);
	assert(
		["", "private"].includes(worker.HostConfig.PidMode ?? ""),
		"BuildKit worker shares a PID namespace",
	);
	assert(
		["", "private"].includes(worker.HostConfig.UTSMode ?? ""),
		"BuildKit worker shares a UTS namespace",
	);
	assert(
		["", "no"].includes(worker.HostConfig.RestartPolicy?.Name ?? ""),
		"BuildKit worker restart policy changed",
	);
	assert(
		worker.HostConfig.PidsLimit === 1024,
		"BuildKit worker PID limit changed",
	);
	assert(
		worker.HostConfig.Memory === 4 * 1024 ** 3,
		"BuildKit worker memory limit changed",
	);
	assert(
		worker.HostConfig.NanoCpus === 4_000_000_000,
		"BuildKit worker CPU limit changed",
	);
	assert(
		worker.HostConfig.OomKillDisable !== true,
		"BuildKit worker disables OOM kill",
	);
	assert(
		worker.HostConfig.PublishAllPorts === false,
		"BuildKit worker publishes ports",
	);
	assert(
		Object.keys(worker.HostConfig.PortBindings ?? {}).length === 0,
		"BuildKit worker binds ports",
	);
	assert(
		(worker.HostConfig.CapAdd ?? []).length === 0,
		"BuildKit worker adds capabilities",
	);
	assert(
		(worker.HostConfig.CapDrop ?? []).length === 0,
		"BuildKit worker capability contract changed",
	);
	assert(
		(worker.HostConfig.Devices ?? []).length === 0,
		"BuildKit worker mounts a host device",
	);
	assert(
		(worker.HostConfig.DeviceRequests ?? []).length === 0,
		"BuildKit worker requests a host device",
	);
	assert(
		[
			JSON.stringify(["apparmor=unconfined", "seccomp=unconfined"]),
			JSON.stringify([
				"apparmor=unconfined",
				"label=disable",
				"seccomp=unconfined",
			]),
		].includes(
			JSON.stringify([...(worker.HostConfig.SecurityOpt ?? [])].sort()),
		),
		"BuildKit worker security options changed",
	);
	assert(
		worker.HostConfig.Tmpfs?.["/run/user/1000"] ===
			"rw,nosuid,nodev,size=64m,uid=1000,gid=1000" &&
			worker.HostConfig.Tmpfs?.["/tmp"] ===
				"rw,nosuid,nodev,size=128m,uid=1000,gid=1000",
		"BuildKit worker tmpfs contract changed",
	);
	const workerMounts = (worker.Mounts ?? [])
		.map((mount) => {
			const typedMount = mount as typeof mount & { Type?: string };
			return [mount.Destination, typedMount.Type ?? "", String(mount.RW)];
		})
		.sort(([left], [right]) => String(left).localeCompare(String(right)));
	assert(
		JSON.stringify(workerMounts) ===
			JSON.stringify(
				[
					["/home/user/.docker", "volume", "true"],
					["/home/user/.local/share/buildkit", "volume", "true"],
					["/run/buildkit", "volume", "true"],
				].sort(([left], [right]) => String(left).localeCompare(String(right))),
			),
		"BuildKit worker mount contract changed",
	);
	assert(
		!(worker.HostConfig.Binds ?? []).some((bind) =>
			bind.includes("docker.sock"),
		),
		"BuildKit worker mounts a host Docker socket",
	);
	assert(
		Object.keys(worker.NetworkSettings.Networks ?? {}).length === 1,
		"BuildKit worker network contract changed",
	);
	assert(
		worker.State.Running,
		"BuildKit worker is not running during inspection",
	);
};

const inspectClientSecurity = async () => {
	const client = await findBuildContainer("client");
	assertExactLabels(client.Config.Labels, "client");
	assert(
		client.Config.User === "1000:1000",
		"BuildKit client is not uid/gid 1000",
	);
	assert(!client.HostConfig.Privileged, "BuildKit client is privileged");
	assert(
		client.HostConfig.ReadonlyRootfs,
		"BuildKit client root filesystem is writable",
	);
	assert(
		client.HostConfig.PidsLimit === 256,
		"BuildKit client PID limit changed",
	);
	assert(
		client.HostConfig.Memory === 1024 ** 3,
		"BuildKit client memory limit changed",
	);
	assert(
		client.HostConfig.NanoCpus === 1_000_000_000,
		"BuildKit client CPU limit changed",
	);
	assert(
		client.HostConfig.OomKillDisable !== true,
		"BuildKit client disables OOM kill",
	);
	assert(
		(client.HostConfig.CapAdd ?? []).length === 0,
		"BuildKit client adds capabilities",
	);
	assert(
		JSON.stringify([...(client.HostConfig.CapDrop ?? [])].sort()) ===
			JSON.stringify(["ALL"]),
		"BuildKit client does not drop all capabilities",
	);
	assert(
		(client.HostConfig.SecurityOpt ?? []).some((option: string) =>
			option.startsWith("no-new-privileges"),
		),
		"BuildKit client permits new privileges",
	);
	assert(
		client.HostConfig.PublishAllPorts === false,
		"BuildKit client publishes ports",
	);
	assert(
		Object.keys(client.HostConfig.PortBindings ?? {}).length === 0,
		"BuildKit client binds ports",
	);
	assert(
		(client.HostConfig.Devices ?? []).length === 0,
		"BuildKit client mounts a host device",
	);
	assert(
		(client.HostConfig.DeviceRequests ?? []).length === 0,
		"BuildKit client requests a host device",
	);
	assert(
		!(client.HostConfig.Binds ?? []).some((bind) =>
			bind.includes("docker.sock"),
		),
		"BuildKit client mounts a Docker socket",
	);
	const networks = Object.keys(client.NetworkSettings.Networks ?? {});
	assert(networks.length === 1, "BuildKit client network contract changed");
	const inspectedNetwork = await docker.getNetwork(networks[0] ?? "").inspect();
	assert(
		Object.keys(inspectedNetwork.Containers ?? {}).length === 2,
		"Only the BuildKit worker and client may attach to the build network",
	);
};

const fileContains = async (file: string, needle: Buffer) => {
	let carry = Buffer.alloc(0);
	for await (const chunk of createReadStream(file, {
		highWaterMark: 64 * 1024,
	})) {
		const bytes = Buffer.from(chunk);
		const combined = carry.length > 0 ? Buffer.concat([carry, bytes]) : bytes;
		if (combined.includes(needle)) return true;
		carry = combined.subarray(
			Math.max(0, combined.length - Math.max(0, needle.length - 1)),
		);
	}
	return false;
};

let runtimeContainerId: string | null = null;
try {
	await mkdir(source, { recursive: true });
	await mkdir(output, { recursive: true });
	await writeFile(secretPath, secret, { encoding: "utf8", mode: 0o600 });
	await writeFile(
		path.join(source, "Dockerfile"),
		`# syntax=docker/dockerfile:1\nFROM busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23\nRUN --mount=type=secret,id=probe test -s /run/secrets/probe\nRUN mkdir -p /www && printf 'phase4-plane-isolation\\n' > /www/index.html\nEXPOSE 8080\nUSER 65534:65534\nCMD [\"httpd\",\"-f\",\"-p\",\"8080\",\"-h\",\"/www\"]\n`,
		"utf8",
	);
	await mkdir(path.join(source, "proof"));
	await writeFile(
		path.join(source, "proof", "complete-tree.txt"),
		"this second file is covered by sourceSnapshotDigest\n",
		{ encoding: "utf8", mode: 0o640 },
	);
	const sourceDigest = (await computeSourceSnapshotDigest(source, 1024 * 1024))
		.digest;
	const buildProvider = new RootlessBuildKitProvider({
		docker,
		progress: async (stage) => {
			console.error(`[phase4-buildkit] ${stage}`);
			if (stage === "waiting-for-rootless-worker") {
				await inspectWorkerSecurity();
			}
			if (stage === "building-artifact") {
				await inspectClientSecurity();
			}
		},
	});
	const registryProvider = new DockerContentRegistryProvider(docker);
	const runtimeProvider = new DockerRuntimeProvider(docker);
	const build = await buildProvider.execute(context, {
		kind: "build.execute",
		buildId: `build-${runId}`,
		leaseId,
		sourceSnapshotPath: source,
		sourceSnapshotDigest: sourceDigest,
		outputDirectory: output,
		imageName,
		architecture: "amd64",
		secretFiles: [{ id: "probe", path: secretPath }],
		maxSourceBytes: 1024 * 1024,
		timeoutMs: 15 * 60 * 1000,
	});
	assert(build.scrubbed, "Build provider did not attest worker scrubbing");
	assert(
		build.sourceSnapshotDigest === sourceDigest,
		"Build provider returned a different complete-tree source digest",
	);
	if (process.platform !== "win32") {
		assert(
			((await lstat(output)).mode & 0o777) === 0o700,
			"Build output directory permissions are not 0700",
		);
		assert(
			((await lstat(build.artifactPath)).mode & 0o777) === 0o600,
			"Build artifact permissions are not 0600",
		);
	}
	await assertNoBuildResidue();
	assert(
		!(await fileContains(build.artifactPath, Buffer.from(secret))),
		"Build secret leaked into the OCI artifact",
	);
	const published = await registryProvider.execute(context, {
		kind: "artifact.publish",
		artifactPath: build.artifactPath,
		imageName,
		expectedContentDigest: build.artifactDigest,
	});
	assert(
		published.kind === "artifact.published",
		"OCI artifact was not published",
	);
	const release = await runtimeProvider.execute(context, {
		kind: "release.create",
		releaseId,
		imageReference: published.imageReference,
		imageDigest: published.imageDigest,
		environment: { PHASE4_RUNTIME: "verified" },
		containerPort: 8080,
		cpuMillis: 250,
		memoryMb: 64,
	});
	assert(release.kind === "release.created", "Runtime release was not created");
	runtimeContainerId = release.runtimePlacementReference;
	assert(
		runtimeContainerId !== build.workerReference,
		"Build worker was reused as runtime target",
	);
	const inspected = await docker.getContainer(runtimeContainerId).inspect();
	assert(
		inspected.Image === published.imageDigest,
		"Runtime did not pull the immutable digest",
	);
	assert(
		inspected.Config.Labels["com.deploytide.plane"] === "runtime",
		"Runtime plane label is missing",
	);
	assert(
		!inspected.Config.Labels["com.deploytide.lease"],
		"Build lease leaked into runtime",
	);
	assert(
		(inspected.Mounts ?? []).length === 0,
		"Runtime contains build or source mounts",
	);
	assert(
		!(inspected.Config.Env ?? []).some((entry) => entry.includes(secret)),
		"Build secret leaked into runtime environment",
	);
	assert(
		!(inspected.Config.Env ?? []).some((entry) => entry.includes(source)),
		"Source checkout path leaked into runtime environment",
	);
	const health = await runtimeProvider.execute(context, {
		kind: "release.health",
		releaseId,
	});
	assert(
		health.kind === "release.health" && health.health === "healthy",
		"Runtime health did not become ready",
	);
	assert(release.endpoint, "Runtime endpoint was not published locally");
	let body = "";
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			const response = await fetch(release.endpoint);
			if (response.ok) {
				body = await response.text();
				break;
			}
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert(
		body.trim() === "phase4-plane-isolation",
		"Runtime traffic proof failed",
	);
	await runtimeProvider.execute(context, {
		kind: "release.drain",
		releaseId,
		graceSeconds: 2,
	});
	runtimeContainerId = null;
	await registryProvider.execute(context, {
		kind: "artifact.delete",
		imageReference: published.imageReference,
	});
	console.log(
		JSON.stringify({
			buildWorker: build.workerReference,
			artifactDigest: published.imageDigest,
			runtimePlacement: release.runtimePlacementReference,
			buildResidue: 0,
			runtimeMounts: 0,
			secretResidue: false,
			traffic: body.trim(),
		}),
	);
} finally {
	if (runtimeContainerId) {
		await docker
			.getContainer(runtimeContainerId)
			.remove({ force: true, v: true })
			.catch(() => undefined);
	}
	await assertNoBuildResidue().catch(() => undefined);
	await rm(root, { recursive: true, force: true });
}
