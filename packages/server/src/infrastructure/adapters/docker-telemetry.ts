import Dockerode from "dockerode";
import type {
	AdapterExecutionContext,
	AdapterProbeResult,
	TelemetryOperation,
	TelemetryOperationResult,
	TelemetryProvider,
} from "../contracts";

const referencePattern = /^[a-f0-9]{12,64}$/i;

const decodeLogs = (buffer: Buffer) => {
	const lines: string[] = [];
	let offset = 0;
	while (offset + 8 <= buffer.length) {
		const size = buffer.readUInt32BE(offset + 4);
		if (offset + 8 + size > buffer.length) break;
		lines.push(
			...buffer
				.subarray(offset + 8, offset + 8 + size)
				.toString("utf8")
				.split(/\r?\n/)
				.filter(Boolean),
		);
		offset += 8 + size;
	}
	return lines.length > 0
		? lines
		: buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
};

export class DockerTelemetryProvider implements TelemetryProvider {
	readonly adapterType = "docker-telemetry";
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
			capabilities: ["telemetry.metrics", "telemetry.logs"],
		};
	}

	async execute(
		context: AdapterExecutionContext,
		operation: TelemetryOperation,
	): Promise<TelemetryOperationResult> {
		if (!referencePattern.test(operation.runtimePlacementReference)) {
			throw new Error("Runtime placement reference is invalid");
		}
		if (context.signal?.aborted) throw context.signal.reason;
		const container = this.#docker.getContainer(
			operation.runtimePlacementReference,
		);
		if (operation.kind === "telemetry.logs") {
			const logs = await container.logs({
				stdout: true,
				stderr: true,
				since: Math.floor(operation.since.getTime() / 1000),
				tail: operation.tail,
				timestamps: true,
			});
			return { kind: "telemetry.logs", lines: decodeLogs(logs) };
		}
		const stats = (await container.stats({ stream: false })) as unknown as {
			cpu_stats?: {
				cpu_usage?: { total_usage?: number };
				system_cpu_usage?: number;
				online_cpus?: number;
			};
			precpu_stats?: {
				cpu_usage?: { total_usage?: number };
				system_cpu_usage?: number;
			};
			memory_stats?: { usage?: number };
		};
		const cpuDelta =
			(stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
			(stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
		const systemDelta =
			(stats.cpu_stats?.system_cpu_usage ?? 0) -
			(stats.precpu_stats?.system_cpu_usage ?? 0);
		const cpuPercent =
			systemDelta > 0
				? (cpuDelta / systemDelta) * (stats.cpu_stats?.online_cpus ?? 1) * 100
				: null;
		const inspected = await container.inspect();
		return {
			kind: "telemetry.health",
			cpuPercent,
			memoryBytes: stats.memory_stats?.usage ?? null,
			restarts: inspected.RestartCount,
			sampledAt: new Date(),
		};
	}
}
