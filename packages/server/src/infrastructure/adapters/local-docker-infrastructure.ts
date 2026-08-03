import Dockerode from "dockerode";
import type {
	AdapterExecutionContext,
	AdapterProbeResult,
	InfrastructureOperation,
	InfrastructureOperationResult,
	InfrastructureProvider,
} from "../contracts";

const referencePattern = /^local-docker:([a-zA-Z0-9._-]+):(build|runtime)$/;

export class LocalDockerInfrastructureProvider
	implements InfrastructureProvider
{
	readonly adapterType = "local-docker";
	readonly #docker: Dockerode;

	constructor(docker: Dockerode = new Dockerode()) {
		this.#docker = docker;
	}

	async probe(context: AdapterExecutionContext): Promise<AdapterProbeResult> {
		if (context.signal?.aborted) throw context.signal.reason;
		const info = await this.#docker.info();
		const version = await this.#docker.version();
		return {
			health: info.ID ? "healthy" : "unavailable",
			version: String(version.Version),
			capabilities: [
				"build.rootless",
				"runtime.container",
				"registry.oci",
				"telemetry.logs",
			],
			details: {
				architecture: String(info.Architecture),
				cpus: Number(info.NCPU),
				memoryBytes: Number(info.MemTotal),
			},
		};
	}

	async execute(
		context: AdapterExecutionContext,
		operation: InfrastructureOperation,
	): Promise<InfrastructureOperationResult> {
		if (context.signal?.aborted) throw context.signal.reason;
		const info = await this.#docker.info();
		const engineId = String(info.ID || "").replace(/[^a-zA-Z0-9._-]/g, "");
		if (!engineId)
			throw new Error("Local Docker engine identity is unavailable");
		if (operation.kind === "capacity.provision") {
			const architecture = String(info.Architecture).includes("arm")
				? "arm64"
				: "amd64";
			if (operation.architecture !== architecture) {
				throw new Error(
					"Local Docker engine does not match requested architecture",
				);
			}
			return {
				kind: "capacity.provisioned",
				providerTargetReference: `local-docker:${engineId}:${operation.capacityKind}`,
				architecture,
				version: String((await this.#docker.version()).Version),
			};
		}
		const parsed = referencePattern.exec(operation.providerTargetReference);
		if (!parsed || parsed[1] !== engineId) {
			throw new Error(
				"Local Docker capacity reference does not belong to this engine",
			);
		}
		if (operation.kind === "capacity.deprovision") {
			return { kind: "capacity.deprovisioned" };
		}
		return {
			kind: "capacity.inspected",
			health: "healthy",
			cpuMillis: Number(info.NCPU) * 1000,
			memoryMb: Math.floor(Number(info.MemTotal) / 1024 / 1024),
		};
	}
}
