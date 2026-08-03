import Dockerode from "dockerode";
import type {
	AdapterExecutionContext,
	AdapterProbeResult,
	RuntimeOperation,
	RuntimeOperationResult,
	RuntimeProvider,
} from "../contracts";

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const envKeyPattern = /^[A-Z_][A-Z0-9_]{0,127}$/;

const releaseName = (releaseId: string) => `deploytide-release-${releaseId}`;

const decodeDockerLogs = (buffer: Buffer) => {
	const chunks: Buffer[] = [];
	let offset = 0;
	while (offset + 8 <= buffer.length) {
		const size = buffer.readUInt32BE(offset + 4);
		if (offset + 8 + size > buffer.length) break;
		chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
		offset += 8 + size;
	}
	return (chunks.length > 0 ? Buffer.concat(chunks) : buffer)
		.toString("utf8")
		.split(/\r?\n/)
		.filter(Boolean);
};

const findReleaseContainer = async (docker: Dockerode, releaseId: string) => {
	const matches = await docker.listContainers({
		all: true,
		filters: { label: [`com.deploytide.release=${releaseId}`] },
	});
	if (matches.length > 1)
		throw new Error("Release has duplicate runtime placements");
	return matches[0] ? docker.getContainer(matches[0].Id) : null;
};

export class DockerRuntimeProvider implements RuntimeProvider {
	readonly adapterType = "docker-runtime";
	readonly #docker: Dockerode;

	constructor(docker: Dockerode = new Dockerode()) {
		this.#docker = docker;
	}

	async probe(context: AdapterExecutionContext): Promise<AdapterProbeResult> {
		if (context.signal?.aborted) throw context.signal.reason;
		const version = await this.#docker.version();
		return {
			health: "healthy",
			version: String(version.Version),
			capabilities: [
				"runtime.container",
				"runtime.read-only",
				"telemetry.logs",
			],
		};
	}

	async execute(
		context: AdapterExecutionContext,
		operation: RuntimeOperation,
	): Promise<RuntimeOperationResult> {
		if (context.signal?.aborted) throw context.signal.reason;
		if (operation.kind === "cluster.health") {
			const version = await this.#docker.version();
			return {
				kind: "cluster.health",
				health: "healthy",
				version: String(version.Version),
			};
		}
		if (!idPattern.test(operation.releaseId))
			throw new Error("Release identifier is invalid");
		if (operation.kind === "release.create") {
			const image = await this.#docker
				.getImage(operation.imageReference)
				.inspect();
			if (image.Id !== operation.imageDigest) {
				throw new Error(
					"Runtime image digest does not match the released artifact",
				);
			}
			const existing = await findReleaseContainer(
				this.#docker,
				operation.releaseId,
			);
			if (existing) {
				const inspected = await existing.inspect();
				if (
					inspected.Config.Labels?.["com.deploytide.fencing-token"] !==
					String(context.fencingToken)
				) {
					throw new Error(
						"Release placement already exists under another fencing token",
					);
				}
				return {
					kind: "release.created",
					runtimePlacementReference: inspected.Id,
					imageDigest: inspected.Image,
				};
			}
			const environment = Object.entries(operation.environment).map(
				([key, value]) => {
					if (!envKeyPattern.test(key) || value.length > 32_768) {
						throw new Error("Runtime environment entry is invalid");
					}
					return `${key}=${value}`;
				},
			);
			const portKey = `${operation.containerPort}/tcp`;
			const container = await this.#docker.createContainer({
				Image: operation.imageReference,
				name: releaseName(operation.releaseId),
				User: "65534:65534",
				Env: environment,
				Labels: {
					"com.deploytide.plane": "runtime",
					"com.deploytide.release": operation.releaseId,
					"com.deploytide.image-digest": operation.imageDigest,
					"com.deploytide.fencing-token": String(context.fencingToken),
				},
				ExposedPorts: { [portKey]: {} },
				HostConfig: {
					AutoRemove: false,
					CapDrop: ["ALL"],
					ReadonlyRootfs: true,
					PidsLimit: 128,
					Memory: operation.memoryMb * 1024 * 1024,
					NanoCpus: operation.cpuMillis * 1_000_000,
					PortBindings: { [portKey]: [{ HostIp: "127.0.0.1", HostPort: "0" }] },
					RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
					SecurityOpt: ["no-new-privileges"],
					Tmpfs: {
						"/tmp": "rw,nosuid,nodev,noexec,size=32m,uid=65534,gid=65534",
					},
				},
			});
			await container.start();
			const inspected = await container.inspect();
			const binding = inspected.NetworkSettings.Ports?.[portKey]?.[0];
			return {
				kind: "release.created",
				runtimePlacementReference: inspected.Id,
				imageDigest: inspected.Image,
				endpoint: binding?.HostPort
					? `http://127.0.0.1:${binding.HostPort}`
					: undefined,
			};
		}
		const container = await findReleaseContainer(
			this.#docker,
			operation.releaseId,
		);
		if (!container) throw new Error("Runtime release placement was not found");
		if (operation.kind === "release.health") {
			const inspected = await container.inspect();
			return {
				kind: "release.health",
				health: inspected.State.Running
					? "healthy"
					: inspected.State.Status === "created"
						? "starting"
						: "unhealthy",
				details: {
					status: inspected.State.Status,
					restartCount: inspected.RestartCount,
				},
			};
		}
		if (operation.kind === "release.logs") {
			const logs = await container.logs({
				stdout: true,
				stderr: true,
				tail: operation.tail,
				timestamps: true,
			});
			return { kind: "release.logs", lines: decodeDockerLogs(logs) };
		}
		await container.stop({ t: operation.graceSeconds }).catch((error) => {
			if ((error as { statusCode?: number }).statusCode !== 304) throw error;
		});
		await container.remove({ force: true, v: true });
		return { kind: "release.drained" };
	}
}
