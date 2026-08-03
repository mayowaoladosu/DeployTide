export type InfrastructureArchitecture = "amd64" | "arm64";

export interface AdapterExecutionContext {
	correlationId: string;
	fencingToken: number;
	providerId: string;
	regionCode: string;
	signal?: AbortSignal;
}

export interface AdapterProbeResult {
	health: "healthy" | "degraded" | "unavailable";
	version: string;
	capabilities: string[];
	details?: Record<string, string | number | boolean>;
}

export type InfrastructureOperation =
	| {
			kind: "capacity.provision";
			requestId: string;
			capacityKind: "build" | "runtime";
			architecture: InfrastructureArchitecture;
			cpuMillis: number;
			memoryMb: number;
			cloudInit: string;
			labels: Record<string, string>;
	  }
	| {
			kind: "capacity.deprovision";
			requestId: string;
			providerTargetReference: string;
	  }
	| {
			kind: "capacity.inspect";
			providerTargetReference: string;
	  };

export type InfrastructureOperationResult =
	| {
			kind: "capacity.provisioned";
			providerTargetReference: string;
			architecture: InfrastructureArchitecture;
			version: string;
	  }
	| { kind: "capacity.deprovisioned" }
	| {
			kind: "capacity.inspected";
			health: "healthy" | "degraded" | "unavailable";
			cpuMillis: number;
			memoryMb: number;
	  };

export interface InfrastructureProvider {
	readonly adapterType: string;
	probe(context: AdapterExecutionContext): Promise<AdapterProbeResult>;
	execute(
		context: AdapterExecutionContext,
		operation: InfrastructureOperation,
	): Promise<InfrastructureOperationResult>;
}

export interface BuildRequest {
	kind: "build.execute";
	buildId: string;
	leaseId: string;
	sourceSnapshotPath: string;
	sourceSnapshotDigest: string;
	outputDirectory: string;
	imageName: string;
	architecture: InfrastructureArchitecture;
	buildArgs?: Record<string, string>;
	secretFiles?: Array<{ id: string; path: string }>;
	maxSourceBytes?: number;
	timeoutMs?: number;
}

export interface BuildResult {
	kind: "build.completed";
	artifactPath: string;
	artifactDigest: string;
	workerReference: string;
	builderVersion: string;
	sourceSnapshotDigest: string;
	scrubbed: boolean;
}

export interface BuildProvider {
	readonly adapterType: string;
	probe(context: AdapterExecutionContext): Promise<AdapterProbeResult>;
	execute(
		context: AdapterExecutionContext,
		request: BuildRequest,
	): Promise<BuildResult>;
}

export type RuntimeOperation =
	| {
			kind: "release.create";
			releaseId: string;
			imageReference: string;
			imageDigest: string;
			environment: Record<string, string>;
			containerPort: number;
			cpuMillis: number;
			memoryMb: number;
	  }
	| { kind: "release.health"; releaseId: string }
	| { kind: "release.drain"; releaseId: string; graceSeconds: number }
	| { kind: "release.logs"; releaseId: string; tail: number }
	| { kind: "cluster.health" };

export type RuntimeOperationResult =
	| {
			kind: "release.created";
			runtimePlacementReference: string;
			imageDigest: string;
			endpoint?: string;
	  }
	| {
			kind: "release.health";
			health: "starting" | "healthy" | "unhealthy";
			details?: Record<string, string | number | boolean>;
	  }
	| { kind: "release.drained" }
	| { kind: "release.logs"; lines: string[] }
	| {
			kind: "cluster.health";
			health: "healthy" | "degraded" | "unavailable";
			version: string;
	  };

export interface RuntimeProvider {
	readonly adapterType: string;
	probe(context: AdapterExecutionContext): Promise<AdapterProbeResult>;
	execute(
		context: AdapterExecutionContext,
		operation: RuntimeOperation,
	): Promise<RuntimeOperationResult>;
}

export type RegistryOperation =
	| {
			kind: "artifact.publish";
			artifactPath: string;
			imageName: string;
			expectedContentDigest: string;
	  }
	| { kind: "artifact.resolve"; imageReference: string }
	| { kind: "artifact.delete"; imageReference: string };

export type RegistryOperationResult =
	| {
			kind: "artifact.published";
			imageReference: string;
			imageDigest: string;
	  }
	| {
			kind: "artifact.resolved";
			imageReference: string;
			imageDigest: string;
	  }
	| { kind: "artifact.deleted" };

export interface RegistryProvider {
	readonly adapterType: string;
	probe(context: AdapterExecutionContext): Promise<AdapterProbeResult>;
	execute(
		context: AdapterExecutionContext,
		operation: RegistryOperation,
	): Promise<RegistryOperationResult>;
}

export type EdgeOperation =
	| {
			kind: "route.publish";
			aliasId: string;
			hostname: string;
			runtimeEndpoint: string;
			expectedVersion: number;
	  }
	| {
			kind: "route.withdraw";
			aliasId: string;
			hostname: string;
			expectedVersion: number;
	  };

export type EdgeOperationResult =
	| { kind: "route.published"; version: number }
	| { kind: "route.withdrawn"; version: number };

export interface EdgeProvider {
	readonly adapterType: string;
	probe(context: AdapterExecutionContext): Promise<AdapterProbeResult>;
	execute(
		context: AdapterExecutionContext,
		operation: EdgeOperation,
	): Promise<EdgeOperationResult>;
}

export type TelemetryOperation =
	| {
			kind: "telemetry.health";
			runtimePlacementReference: string;
	  }
	| {
			kind: "telemetry.logs";
			runtimePlacementReference: string;
			since: Date;
			tail: number;
	  };

export type TelemetryOperationResult =
	| {
			kind: "telemetry.health";
			cpuPercent: number | null;
			memoryBytes: number | null;
			restarts: number | null;
			sampledAt: Date;
	  }
	| { kind: "telemetry.logs"; lines: string[] };

export interface TelemetryProvider {
	readonly adapterType: string;
	probe(context: AdapterExecutionContext): Promise<AdapterProbeResult>;
	execute(
		context: AdapterExecutionContext,
		operation: TelemetryOperation,
	): Promise<TelemetryOperationResult>;
}

export type ProviderKind =
	| "infrastructure"
	| "build"
	| "runtime"
	| "registry"
	| "edge"
	| "telemetry";

export interface ProviderContractMap {
	infrastructure: InfrastructureProvider;
	build: BuildProvider;
	runtime: RuntimeProvider;
	registry: RegistryProvider;
	edge: EdgeProvider;
	telemetry: TelemetryProvider;
}
