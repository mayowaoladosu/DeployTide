import { pgEnum } from "drizzle-orm/pg-core";

export const infrastructureHealth = pgEnum("infrastructureHealth", [
	"unknown",
	"healthy",
	"degraded",
	"unavailable",
]);

export const infrastructureStatus = pgEnum("infrastructureStatus", [
	"provisioning",
	"ready",
	"degraded",
	"unavailable",
	"disabled",
]);

export const infrastructureArchitecture = pgEnum("infrastructureArchitecture", [
	"amd64",
	"arm64",
]);

export const infrastructureDrainState = pgEnum("infrastructureDrainState", [
	"active",
	"draining",
	"drained",
]);

export const capacityLeaseKind = pgEnum("capacityLeaseKind", [
	"build",
	"runtime",
]);

export const capacityLeaseState = pgEnum("capacityLeaseState", [
	"active",
	"releasing",
	"released",
	"expired",
	"reconciling",
	"failed",
]);

export const capacityReconciliationState = pgEnum(
	"capacityReconciliationState",
	["clean", "pending", "running", "recovered", "failed"],
);

export const operatorJobKind = pgEnum("operatorJobKind", [
	"release_create",
	"release_health",
	"release_drain",
	"release_logs",
	"cluster_health",
	"certificate_rotate",
]);

export const operatorJobStatus = pgEnum("operatorJobStatus", [
	"queued",
	"acknowledged",
	"running",
	"succeeded",
	"failed",
	"cancelled",
]);

export const controllerCertificateStatus = pgEnum(
	"controllerCertificateStatus",
	["active", "rotating", "revoked", "expired"],
);

export const infrastructureIncidentSeverity = pgEnum(
	"infrastructureIncidentSeverity",
	["info", "warning", "critical"],
);

export const infrastructureIncidentStatus = pgEnum(
	"infrastructureIncidentStatus",
	["open", "monitoring", "resolved"],
);

export const legacyInfrastructureDisposition = pgEnum(
	"legacyInfrastructureDisposition",
	[
		"ambiguous",
		"platform_owned",
		"customer_owned",
		"exported",
		"imported",
		"rejected",
	],
);
