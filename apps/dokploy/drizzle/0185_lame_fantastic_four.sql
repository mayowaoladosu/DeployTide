CREATE TYPE "public"."capacityLeaseKind" AS ENUM('build', 'runtime');--> statement-breakpoint
CREATE TYPE "public"."capacityLeaseState" AS ENUM('active', 'releasing', 'released', 'expired', 'reconciling', 'failed');--> statement-breakpoint
CREATE TYPE "public"."capacityReconciliationState" AS ENUM('clean', 'pending', 'running', 'recovered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."controllerCertificateStatus" AS ENUM('active', 'rotating', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."infrastructureArchitecture" AS ENUM('amd64', 'arm64');--> statement-breakpoint
CREATE TYPE "public"."infrastructureDrainState" AS ENUM('active', 'draining', 'drained');--> statement-breakpoint
CREATE TYPE "public"."infrastructureHealth" AS ENUM('unknown', 'healthy', 'degraded', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."infrastructureIncidentSeverity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."infrastructureIncidentStatus" AS ENUM('open', 'monitoring', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."infrastructureStatus" AS ENUM('provisioning', 'ready', 'degraded', 'unavailable', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."legacyInfrastructureDisposition" AS ENUM('ambiguous', 'platform_owned', 'customer_owned', 'exported', 'imported', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."operatorJobKind" AS ENUM('release_create', 'release_health', 'release_drain', 'release_logs', 'cluster_health', 'certificate_rotate');--> statement-breakpoint
CREATE TYPE "public"."operatorJobStatus" AS ENUM('queued', 'acknowledged', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "buildPool" (
	"buildPoolId" text PRIMARY KEY NOT NULL,
	"infrastructureProviderId" text NOT NULL,
	"regionId" text NOT NULL,
	"name" text NOT NULL,
	"adapterType" text NOT NULL,
	"architecture" "infrastructureArchitecture" NOT NULL,
	"workerClass" text NOT NULL,
	"rootless" boolean DEFAULT true NOT NULL,
	"minCapacity" integer DEFAULT 0 NOT NULL,
	"maxCapacity" integer NOT NULL,
	"totalCapacity" integer NOT NULL,
	"reservedCapacity" integer DEFAULT 0 NOT NULL,
	"cacheNamespace" text NOT NULL,
	"endpointReference" text,
	"health" "infrastructureHealth" DEFAULT 'unknown' NOT NULL,
	"drainState" "infrastructureDrainState" DEFAULT 'active' NOT NULL,
	"autoscalingPolicy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" text NOT NULL,
	"lastHealthAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone,
	CONSTRAINT "build_pool_capacity_valid" CHECK ("buildPool"."minCapacity" >= 0 AND "buildPool"."maxCapacity" > 0 AND "buildPool"."totalCapacity" >= "buildPool"."minCapacity" AND "buildPool"."totalCapacity" <= "buildPool"."maxCapacity" AND "buildPool"."reservedCapacity" >= 0 AND "buildPool"."reservedCapacity" <= "buildPool"."totalCapacity"),
	CONSTRAINT "build_pool_rootless_required" CHECK ("buildPool"."rootless" = true)
);
--> statement-breakpoint
CREATE TABLE "capacityLease" (
	"capacityLeaseId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"operationId" text NOT NULL,
	"buildId" text,
	"releaseId" text,
	"buildPoolId" text,
	"runtimeClusterId" text,
	"runtimeTargetId" text,
	"kind" "capacityLeaseKind" NOT NULL,
	"leaseScope" text DEFAULT 'workspace' NOT NULL,
	"reservedCapacity" integer DEFAULT 0 NOT NULL,
	"reservedCpuMillis" integer DEFAULT 0 NOT NULL,
	"reservedMemoryMb" integer DEFAULT 0 NOT NULL,
	"leaseOwner" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"fencingToken" bigserial NOT NULL,
	"state" "capacityLeaseState" DEFAULT 'active' NOT NULL,
	"reconciliationState" "capacityReconciliationState" DEFAULT 'clean' NOT NULL,
	"reconciliationAttempts" integer DEFAULT 0 NOT NULL,
	"reconciliationError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"releasedAt" timestamp with time zone,
	CONSTRAINT "capacity_lease_scope_valid" CHECK ("capacityLease"."leaseScope" IN ('workspace', 'operator')),
	CONSTRAINT "capacity_lease_tuple_valid" CHECK (("capacityLease"."kind" = 'build' AND "capacityLease"."buildPoolId" IS NOT NULL AND "capacityLease"."runtimeClusterId" IS NULL AND "capacityLease"."runtimeTargetId" IS NULL AND "capacityLease"."releaseId" IS NULL AND "capacityLease"."reservedCapacity" > 0 AND "capacityLease"."reservedCpuMillis" = 0 AND "capacityLease"."reservedMemoryMb" = 0 AND (("capacityLease"."leaseScope" = 'workspace' AND "capacityLease"."buildId" IS NOT NULL) OR ("capacityLease"."leaseScope" = 'operator' AND "capacityLease"."buildId" IS NULL))) OR ("capacityLease"."kind" = 'runtime' AND "capacityLease"."buildPoolId" IS NULL AND "capacityLease"."runtimeClusterId" IS NOT NULL AND "capacityLease"."runtimeTargetId" IS NOT NULL AND "capacityLease"."buildId" IS NULL AND "capacityLease"."reservedCapacity" = 0 AND "capacityLease"."reservedCpuMillis" > 0 AND "capacityLease"."reservedMemoryMb" > 0 AND (("capacityLease"."leaseScope" = 'workspace' AND "capacityLease"."releaseId" IS NOT NULL) OR ("capacityLease"."leaseScope" = 'operator' AND "capacityLease"."releaseId" IS NULL)))),
	CONSTRAINT "capacity_lease_reservation_nonnegative" CHECK ("capacityLease"."reservedCapacity" >= 0 AND "capacityLease"."reservedCpuMillis" >= 0 AND "capacityLease"."reservedMemoryMb" >= 0),
	CONSTRAINT "capacity_lease_reconciliation_attempts_nonnegative" CHECK ("capacityLease"."reconciliationAttempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "controllerCertificate" (
	"controllerCertificateId" text PRIMARY KEY NOT NULL,
	"runtimeClusterId" text NOT NULL,
	"serialNumber" text NOT NULL,
	"subject" text NOT NULL,
	"certificatePem" text NOT NULL,
	"privateKeyReference" text NOT NULL,
	"caFingerprint" text NOT NULL,
	"status" "controllerCertificateStatus" DEFAULT 'active' NOT NULL,
	"notBefore" timestamp with time zone NOT NULL,
	"notAfter" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"revokedAt" timestamp with time zone,
	"revocationReason" text,
	CONSTRAINT "controller_certificate_external_key_reference" CHECK ("controllerCertificate"."privateKeyReference" LIKE 'operator-secret-id://%')
);
--> statement-breakpoint
CREATE TABLE "infrastructureIncident" (
	"infrastructureIncidentId" text PRIMARY KEY NOT NULL,
	"infrastructureProviderId" text,
	"regionId" text,
	"buildPoolId" text,
	"runtimeClusterId" text,
	"severity" "infrastructureIncidentSeverity" NOT NULL,
	"status" "infrastructureIncidentStatus" DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"redactedDetails" jsonb,
	"openedBy" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"resolvedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "infrastructureProvider" (
	"infrastructureProviderId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"adapterType" text NOT NULL,
	"endpointReference" text NOT NULL,
	"secretReference" text,
	"enabledRegionCodes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"health" "infrastructureHealth" DEFAULT 'unknown' NOT NULL,
	"status" "infrastructureStatus" DEFAULT 'provisioning' NOT NULL,
	"version" text NOT NULL,
	"lastHealthAt" timestamp with time zone,
	"healthDetails" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "legacyInfrastructureInput" (
	"legacyInfrastructureInputId" text PRIMARY KEY NOT NULL,
	"serverId" text NOT NULL,
	"disposition" "legacyInfrastructureDisposition" DEFAULT 'ambiguous' NOT NULL,
	"reviewNote" text,
	"exportPayload" jsonb,
	"importedRuntimeClusterId" text,
	"importedRuntimeTargetId" text,
	"reviewedBy" text,
	"reviewedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operatorAuditLog" (
	"operatorAuditLogId" text PRIMARY KEY NOT NULL,
	"actorUserId" text NOT NULL,
	"actorEmail" text NOT NULL,
	"action" text NOT NULL,
	"resourceType" text NOT NULL,
	"resourceId" text,
	"requestId" text,
	"metadata" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operatorJobAttempt" (
	"operatorJobAttemptId" text PRIMARY KEY NOT NULL,
	"operationId" text NOT NULL,
	"capacityLeaseId" text NOT NULL,
	"buildPoolId" text,
	"runtimeClusterId" text,
	"kind" "operatorJobKind" NOT NULL,
	"sequence" bigserial NOT NULL,
	"fencingToken" bigint NOT NULL,
	"request" jsonb NOT NULL,
	"signature" text,
	"status" "operatorJobStatus" DEFAULT 'queued' NOT NULL,
	"acknowledgedAt" timestamp with time zone,
	"progress" jsonb,
	"result" jsonb,
	"retryable" boolean DEFAULT false NOT NULL,
	"redactedDiagnostics" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp with time zone,
	CONSTRAINT "operator_job_target_valid" CHECK ("operatorJobAttempt"."buildPoolId" IS NULL AND "operatorJobAttempt"."runtimeClusterId" IS NOT NULL),
	CONSTRAINT "operator_job_fencing_token_positive" CHECK ("operatorJobAttempt"."fencingToken" > 0),
	CONSTRAINT "operator_job_release_environment_empty" CHECK ("operatorJobAttempt"."kind" <> 'release_create' OR (jsonb_typeof("operatorJobAttempt"."request") = 'object' AND "operatorJobAttempt"."request" ? 'environment' AND "operatorJobAttempt"."request"->'environment' = '{}'::jsonb)),
	CONSTRAINT "operator_job_payload_bounds" CHECK (octet_length("operatorJobAttempt"."request"::text) <= 1048576 AND ("operatorJobAttempt"."progress" IS NULL OR octet_length("operatorJobAttempt"."progress"::text) <= 65536) AND ("operatorJobAttempt"."result" IS NULL OR octet_length("operatorJobAttempt"."result"::text) <= 65536) AND ("operatorJobAttempt"."redactedDiagnostics" IS NULL OR char_length("operatorJobAttempt"."redactedDiagnostics") <= 8000))
);
--> statement-breakpoint
CREATE TABLE "projectPlacementPolicy" (
	"projectId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"preferredRegionCode" text,
	"requiredCapabilities" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"architecture" "infrastructureArchitecture",
	"dataAffinity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"costClass" text DEFAULT 'balanced' NOT NULL,
	"fairQueueWeight" integer DEFAULT 100 NOT NULL,
	"pinToRegion" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_placement_policy_weight_valid" CHECK ("projectPlacementPolicy"."fairQueueWeight" >= 1 AND "projectPlacementPolicy"."fairQueueWeight" <= 10000),
	CONSTRAINT "project_placement_policy_cost_class_valid" CHECK ("projectPlacementPolicy"."costClass" IN ('economy', 'balanced', 'performance')),
	CONSTRAINT "project_placement_policy_pin_region_valid" CHECK ("projectPlacementPolicy"."pinToRegion" = false OR "projectPlacementPolicy"."preferredRegionCode" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "region" (
	"regionId" text PRIMARY KEY NOT NULL,
	"infrastructureProviderId" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"providerRegionReference" text NOT NULL,
	"buildAvailable" boolean DEFAULT false NOT NULL,
	"runtimeAvailable" boolean DEFAULT false NOT NULL,
	"status" "infrastructureStatus" DEFAULT 'provisioning' NOT NULL,
	"residencyMetadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"routingWeight" integer DEFAULT 100 NOT NULL,
	"costWeight" integer DEFAULT 100 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone,
	CONSTRAINT "region_routing_weight_positive" CHECK ("region"."routingWeight" > 0 AND "region"."costWeight" > 0)
);
--> statement-breakpoint
CREATE TABLE "runtimeCluster" (
	"runtimeClusterId" text PRIMARY KEY NOT NULL,
	"infrastructureProviderId" text NOT NULL,
	"regionId" text NOT NULL,
	"name" text NOT NULL,
	"runtimeAdapter" text NOT NULL,
	"endpointReference" text NOT NULL,
	"certificateReference" text NOT NULL,
	"controllerIdentity" text NOT NULL,
	"totalCpuMillis" integer NOT NULL,
	"reservedCpuMillis" integer DEFAULT 0 NOT NULL,
	"totalMemoryMb" integer NOT NULL,
	"reservedMemoryMb" integer DEFAULT 0 NOT NULL,
	"health" "infrastructureHealth" DEFAULT 'unknown' NOT NULL,
	"drainState" "infrastructureDrainState" DEFAULT 'active' NOT NULL,
	"controllerVersion" text NOT NULL,
	"version" text NOT NULL,
	"lastHeartbeatAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone,
	CONSTRAINT "runtime_cluster_capacity_valid" CHECK ("runtimeCluster"."totalCpuMillis" > 0 AND "runtimeCluster"."reservedCpuMillis" >= 0 AND "runtimeCluster"."reservedCpuMillis" <= "runtimeCluster"."totalCpuMillis" AND "runtimeCluster"."totalMemoryMb" > 0 AND "runtimeCluster"."reservedMemoryMb" >= 0 AND "runtimeCluster"."reservedMemoryMb" <= "runtimeCluster"."totalMemoryMb")
);
--> statement-breakpoint
CREATE TABLE "runtimeTarget" (
	"runtimeTargetId" text PRIMARY KEY NOT NULL,
	"runtimeClusterId" text NOT NULL,
	"providerTargetReference" text NOT NULL,
	"architecture" "infrastructureArchitecture" NOT NULL,
	"totalCpuMillis" integer NOT NULL,
	"reservedCpuMillis" integer DEFAULT 0 NOT NULL,
	"totalMemoryMb" integer NOT NULL,
	"reservedMemoryMb" integer DEFAULT 0 NOT NULL,
	"health" "infrastructureHealth" DEFAULT 'unknown' NOT NULL,
	"drainState" "infrastructureDrainState" DEFAULT 'active' NOT NULL,
	"placementLabels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lastHeartbeatAt" timestamp with time zone,
	"version" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone,
	CONSTRAINT "runtime_target_capacity_valid" CHECK ("runtimeTarget"."totalCpuMillis" > 0 AND "runtimeTarget"."reservedCpuMillis" >= 0 AND "runtimeTarget"."reservedCpuMillis" <= "runtimeTarget"."totalCpuMillis" AND "runtimeTarget"."totalMemoryMb" > 0 AND "runtimeTarget"."reservedMemoryMb" >= 0 AND "runtimeTarget"."reservedMemoryMb" <= "runtimeTarget"."totalMemoryMb")
);
--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "operatorOwned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "release" ADD COLUMN "runtimeTargetId" text;--> statement-breakpoint
ALTER TABLE "release" ADD COLUMN "previousRuntimeTargetId" text;--> statement-breakpoint
ALTER TABLE "release" ADD COLUMN "previousRuntimePlacementId" text;--> statement-breakpoint
ALTER TABLE "release" ADD COLUMN "runtimeRelocationId" text;--> statement-breakpoint
ALTER TABLE "release" ADD COLUMN "runtimeRelocationState" text;--> statement-breakpoint
ALTER TABLE "release" ADD COLUMN "runtimeRelocationError" text;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_runtime_relocation_state_valid" CHECK (("release"."runtimeRelocationState" IS NULL AND "release"."runtimeRelocationId" IS NULL AND "release"."previousRuntimeTargetId" IS NULL AND "release"."previousRuntimePlacementId" IS NULL AND "release"."runtimeRelocationError" IS NULL) OR ("release"."runtimeRelocationState" IN ('preparing', 'draining_old', 'failed') AND "release"."runtimeRelocationId" IS NOT NULL AND "release"."previousRuntimeTargetId" IS NOT NULL AND "release"."previousRuntimePlacementId" IS NOT NULL));--> statement-breakpoint
INSERT INTO "legacyInfrastructureInput" (
	"legacyInfrastructureInputId",
	"serverId",
	"disposition",
	"createdAt",
	"updatedAt"
)
SELECT
	'legacy-' || substring(md5("serverId"), 1, 20),
	"serverId",
	'ambiguous'::"legacyInfrastructureDisposition",
	now(),
	now()
FROM "server"
WHERE "deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "capacity_lease_job_tuple_unique" ON "capacityLease" USING btree ("capacityLeaseId","operationId","runtimeClusterId","fencingToken");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_target_id_cluster_unique" ON "runtimeTarget" USING btree ("runtimeTargetId","runtimeClusterId");--> statement-breakpoint
ALTER TABLE "buildPool" ADD CONSTRAINT "buildPool_infrastructureProviderId_infrastructureProvider_infrastructureProviderId_fk" FOREIGN KEY ("infrastructureProviderId") REFERENCES "public"."infrastructureProvider"("infrastructureProviderId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buildPool" ADD CONSTRAINT "buildPool_regionId_region_regionId_fk" FOREIGN KEY ("regionId") REFERENCES "public"."region"("regionId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacityLease" ADD CONSTRAINT "capacityLease_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacityLease" ADD CONSTRAINT "capacityLease_operationId_operation_operationId_fk" FOREIGN KEY ("operationId") REFERENCES "public"."operation"("operationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacityLease" ADD CONSTRAINT "capacityLease_buildId_build_buildId_fk" FOREIGN KEY ("buildId") REFERENCES "public"."build"("buildId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacityLease" ADD CONSTRAINT "capacityLease_releaseId_release_releaseId_fk" FOREIGN KEY ("releaseId") REFERENCES "public"."release"("releaseId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacityLease" ADD CONSTRAINT "capacityLease_buildPoolId_buildPool_buildPoolId_fk" FOREIGN KEY ("buildPoolId") REFERENCES "public"."buildPool"("buildPoolId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacityLease" ADD CONSTRAINT "capacityLease_runtimeClusterId_runtimeCluster_runtimeClusterId_fk" FOREIGN KEY ("runtimeClusterId") REFERENCES "public"."runtimeCluster"("runtimeClusterId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacityLease" ADD CONSTRAINT "capacityLease_runtimeTargetId_runtimeTarget_runtimeTargetId_fk" FOREIGN KEY ("runtimeTargetId") REFERENCES "public"."runtimeTarget"("runtimeTargetId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacityLease" ADD CONSTRAINT "capacity_lease_release_ownership_fk" FOREIGN KEY ("releaseId","organizationId") REFERENCES "public"."release"("releaseId","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacityLease" ADD CONSTRAINT "capacity_lease_runtime_target_cluster_fk" FOREIGN KEY ("runtimeTargetId","runtimeClusterId") REFERENCES "public"."runtimeTarget"("runtimeTargetId","runtimeClusterId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controllerCertificate" ADD CONSTRAINT "controllerCertificate_runtimeClusterId_runtimeCluster_runtimeClusterId_fk" FOREIGN KEY ("runtimeClusterId") REFERENCES "public"."runtimeCluster"("runtimeClusterId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infrastructureIncident" ADD CONSTRAINT "infrastructureIncident_infrastructureProviderId_infrastructureProvider_infrastructureProviderId_fk" FOREIGN KEY ("infrastructureProviderId") REFERENCES "public"."infrastructureProvider"("infrastructureProviderId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infrastructureIncident" ADD CONSTRAINT "infrastructureIncident_regionId_region_regionId_fk" FOREIGN KEY ("regionId") REFERENCES "public"."region"("regionId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infrastructureIncident" ADD CONSTRAINT "infrastructureIncident_buildPoolId_buildPool_buildPoolId_fk" FOREIGN KEY ("buildPoolId") REFERENCES "public"."buildPool"("buildPoolId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infrastructureIncident" ADD CONSTRAINT "infrastructureIncident_runtimeClusterId_runtimeCluster_runtimeClusterId_fk" FOREIGN KEY ("runtimeClusterId") REFERENCES "public"."runtimeCluster"("runtimeClusterId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacyInfrastructureInput" ADD CONSTRAINT "legacyInfrastructureInput_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacyInfrastructureInput" ADD CONSTRAINT "legacyInfrastructureInput_importedRuntimeClusterId_runtimeCluster_runtimeClusterId_fk" FOREIGN KEY ("importedRuntimeClusterId") REFERENCES "public"."runtimeCluster"("runtimeClusterId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacyInfrastructureInput" ADD CONSTRAINT "legacyInfrastructureInput_importedRuntimeTargetId_runtimeTarget_runtimeTargetId_fk" FOREIGN KEY ("importedRuntimeTargetId") REFERENCES "public"."runtimeTarget"("runtimeTargetId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operatorJobAttempt" ADD CONSTRAINT "operatorJobAttempt_operationId_operation_operationId_fk" FOREIGN KEY ("operationId") REFERENCES "public"."operation"("operationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operatorJobAttempt" ADD CONSTRAINT "operatorJobAttempt_capacityLeaseId_capacityLease_capacityLeaseId_fk" FOREIGN KEY ("capacityLeaseId") REFERENCES "public"."capacityLease"("capacityLeaseId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operatorJobAttempt" ADD CONSTRAINT "operatorJobAttempt_buildPoolId_buildPool_buildPoolId_fk" FOREIGN KEY ("buildPoolId") REFERENCES "public"."buildPool"("buildPoolId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operatorJobAttempt" ADD CONSTRAINT "operatorJobAttempt_runtimeClusterId_runtimeCluster_runtimeClusterId_fk" FOREIGN KEY ("runtimeClusterId") REFERENCES "public"."runtimeCluster"("runtimeClusterId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operatorJobAttempt" ADD CONSTRAINT "operator_job_lease_tuple_fk" FOREIGN KEY ("capacityLeaseId","operationId","runtimeClusterId","fencingToken") REFERENCES "public"."capacityLease"("capacityLeaseId","operationId","runtimeClusterId","fencingToken") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projectPlacementPolicy" ADD CONSTRAINT "projectPlacementPolicy_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projectPlacementPolicy" ADD CONSTRAINT "projectPlacementPolicy_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projectPlacementPolicy" ADD CONSTRAINT "project_placement_policy_ownership_fk" FOREIGN KEY ("projectId","organizationId") REFERENCES "public"."project"("projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region" ADD CONSTRAINT "region_infrastructureProviderId_infrastructureProvider_infrastructureProviderId_fk" FOREIGN KEY ("infrastructureProviderId") REFERENCES "public"."infrastructureProvider"("infrastructureProviderId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtimeCluster" ADD CONSTRAINT "runtimeCluster_infrastructureProviderId_infrastructureProvider_infrastructureProviderId_fk" FOREIGN KEY ("infrastructureProviderId") REFERENCES "public"."infrastructureProvider"("infrastructureProviderId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtimeCluster" ADD CONSTRAINT "runtimeCluster_regionId_region_regionId_fk" FOREIGN KEY ("regionId") REFERENCES "public"."region"("regionId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtimeTarget" ADD CONSTRAINT "runtimeTarget_runtimeClusterId_runtimeCluster_runtimeClusterId_fk" FOREIGN KEY ("runtimeClusterId") REFERENCES "public"."runtimeCluster"("runtimeClusterId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_runtimeTargetId_runtimeTarget_runtimeTargetId_fk" FOREIGN KEY ("runtimeTargetId") REFERENCES "public"."runtimeTarget"("runtimeTargetId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_previousRuntimeTargetId_runtimeTarget_runtimeTargetId_fk" FOREIGN KEY ("previousRuntimeTargetId") REFERENCES "public"."runtimeTarget"("runtimeTargetId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "build_pool_region_name_unique" ON "buildPool" USING btree ("regionId","name");--> statement-breakpoint
CREATE INDEX "build_pool_schedule_idx" ON "buildPool" USING btree ("regionId","architecture","health","drainState");--> statement-breakpoint
CREATE UNIQUE INDEX "capacity_lease_fencing_token_unique" ON "capacityLease" USING btree ("fencingToken");--> statement-breakpoint
CREATE INDEX "capacity_lease_expiry_idx" ON "capacityLease" USING btree ("state","expiresAt");--> statement-breakpoint
CREATE INDEX "capacity_lease_pool_idx" ON "capacityLease" USING btree ("buildPoolId","state");--> statement-breakpoint
CREATE INDEX "capacity_lease_cluster_idx" ON "capacityLease" USING btree ("runtimeClusterId","state");--> statement-breakpoint
CREATE INDEX "capacity_lease_workspace_idx" ON "capacityLease" USING btree ("organizationId","kind","state");--> statement-breakpoint
CREATE UNIQUE INDEX "controller_certificate_serial_unique" ON "controllerCertificate" USING btree ("serialNumber");--> statement-breakpoint
CREATE INDEX "controller_certificate_cluster_status_idx" ON "controllerCertificate" USING btree ("runtimeClusterId","status");--> statement-breakpoint
CREATE INDEX "controller_certificate_expiry_idx" ON "controllerCertificate" USING btree ("status","notAfter");--> statement-breakpoint
CREATE INDEX "infrastructure_incident_status_idx" ON "infrastructureIncident" USING btree ("status","severity","createdAt");--> statement-breakpoint
CREATE INDEX "infrastructure_incident_cluster_idx" ON "infrastructureIncident" USING btree ("runtimeClusterId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "infrastructure_provider_name_unique" ON "infrastructureProvider" USING btree ("name");--> statement-breakpoint
CREATE INDEX "infrastructure_provider_status_idx" ON "infrastructureProvider" USING btree ("status","health");--> statement-breakpoint
CREATE INDEX "infrastructure_provider_adapter_idx" ON "infrastructureProvider" USING btree ("adapterType");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_infrastructure_server_unique" ON "legacyInfrastructureInput" USING btree ("serverId");--> statement-breakpoint
CREATE INDEX "legacy_infrastructure_disposition_idx" ON "legacyInfrastructureInput" USING btree ("disposition");--> statement-breakpoint
CREATE INDEX "operator_audit_created_idx" ON "operatorAuditLog" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "operator_audit_resource_idx" ON "operatorAuditLog" USING btree ("resourceType","resourceId");--> statement-breakpoint
CREATE INDEX "operator_audit_actor_idx" ON "operatorAuditLog" USING btree ("actorUserId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_job_sequence_unique" ON "operatorJobAttempt" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "operator_job_cluster_status_idx" ON "operatorJobAttempt" USING btree ("runtimeClusterId","status","sequence");--> statement-breakpoint
CREATE INDEX "operator_job_pool_status_idx" ON "operatorJobAttempt" USING btree ("buildPoolId","status");--> statement-breakpoint
CREATE INDEX "operator_job_operation_idx" ON "operatorJobAttempt" USING btree ("operationId","status");--> statement-breakpoint
CREATE INDEX "project_placement_policy_region_idx" ON "projectPlacementPolicy" USING btree ("preferredRegionCode","architecture");--> statement-breakpoint
CREATE INDEX "release_runtime_target_status_idx" ON "release" USING btree ("runtimeTargetId","status");--> statement-breakpoint
CREATE INDEX "release_previous_runtime_target_idx" ON "release" USING btree ("previousRuntimeTargetId","runtimeRelocationState");--> statement-breakpoint
CREATE UNIQUE INDEX "region_code_unique" ON "region" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "region_provider_reference_unique" ON "region" USING btree ("infrastructureProviderId","providerRegionReference");--> statement-breakpoint
CREATE INDEX "region_provider_status_idx" ON "region" USING btree ("infrastructureProviderId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_cluster_region_name_unique" ON "runtimeCluster" USING btree ("regionId","name");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_cluster_controller_identity_unique" ON "runtimeCluster" USING btree ("controllerIdentity");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_cluster_id_region_provider_unique" ON "runtimeCluster" USING btree ("runtimeClusterId","regionId","infrastructureProviderId");--> statement-breakpoint
CREATE INDEX "runtime_cluster_schedule_idx" ON "runtimeCluster" USING btree ("regionId","health","drainState");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_target_provider_reference_unique" ON "runtimeTarget" USING btree ("runtimeClusterId","providerTargetReference");--> statement-breakpoint
CREATE INDEX "runtime_target_schedule_idx" ON "runtimeTarget" USING btree ("runtimeClusterId","architecture","health","drainState");--> statement-breakpoint
CREATE OR REPLACE FUNCTION deploytide_guard_state_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	allowed boolean := false;
	current_state text := OLD.status::text;
	next_state text := NEW.status::text;
BEGIN
	IF current_state = next_state THEN
		IF TG_TABLE_NAME = 'deployment' AND
			current_state IN ('ready', 'done', 'failed', 'error', 'cancelled') AND
			(to_jsonb(OLD) ->> 'deletedAt') IS NULL AND
			(to_jsonb(NEW) ->> 'deletedAt') IS NOT NULL AND
			((to_jsonb(NEW) ->> 'composeId') IS NULL OR (to_jsonb(NEW) ->> 'composeId') = (to_jsonb(OLD) ->> 'composeId')) AND
			(to_jsonb(NEW) - ARRAY['deletedAt', 'composeId']) IS NOT DISTINCT FROM
			(to_jsonb(OLD) - ARRAY['deletedAt', 'composeId'])
		THEN
			RETURN NEW;
		END IF;
		IF TG_TABLE_NAME = 'release' AND current_state = 'ready' AND
			(to_jsonb(NEW) - ARRAY[
				'runtimeTargetId', 'runtimePlacementId',
				'previousRuntimeTargetId', 'previousRuntimePlacementId',
				'runtimeRelocationId', 'runtimeRelocationState',
				'runtimeRelocationError'
			]) IS NOT DISTINCT FROM
			(to_jsonb(OLD) - ARRAY[
				'runtimeTargetId', 'runtimePlacementId',
				'previousRuntimeTargetId', 'previousRuntimePlacementId',
				'runtimeRelocationId', 'runtimeRelocationState',
				'runtimeRelocationError'
			]) AND (
				(
					(to_jsonb(OLD) ->> 'runtimeRelocationState') IS NULL AND
					(to_jsonb(NEW) ->> 'runtimeRelocationState') = 'preparing' AND
					(to_jsonb(OLD) ->> 'runtimeTargetId') IS NOT NULL AND
					(to_jsonb(OLD) ->> 'runtimePlacementId') IS NOT NULL AND
					(to_jsonb(OLD) ->> 'previousRuntimeTargetId') IS NULL AND
					(to_jsonb(OLD) ->> 'previousRuntimePlacementId') IS NULL AND
					(to_jsonb(NEW) ->> 'runtimeTargetId') = (to_jsonb(OLD) ->> 'runtimeTargetId') AND
					(to_jsonb(NEW) ->> 'runtimePlacementId') = (to_jsonb(OLD) ->> 'runtimePlacementId') AND
					(to_jsonb(NEW) ->> 'previousRuntimeTargetId') = (to_jsonb(OLD) ->> 'runtimeTargetId') AND
					(to_jsonb(NEW) ->> 'previousRuntimePlacementId') = (to_jsonb(OLD) ->> 'runtimePlacementId') AND
					(to_jsonb(NEW) ->> 'runtimeRelocationId') IS NOT NULL AND
					(to_jsonb(NEW) ->> 'runtimeRelocationError') IS NULL
				) OR (
					(to_jsonb(OLD) ->> 'runtimeRelocationState') IN ('preparing', 'failed') AND
					(to_jsonb(NEW) ->> 'runtimeRelocationState') = 'draining_old' AND
					(to_jsonb(NEW) ->> 'runtimeRelocationId') = (to_jsonb(OLD) ->> 'runtimeRelocationId') AND
					(to_jsonb(NEW) ->> 'previousRuntimeTargetId') = (to_jsonb(OLD) ->> 'previousRuntimeTargetId') AND
					(to_jsonb(NEW) ->> 'previousRuntimePlacementId') = (to_jsonb(OLD) ->> 'previousRuntimePlacementId') AND
					(to_jsonb(NEW) ->> 'runtimeTargetId') IS NOT NULL AND
					(to_jsonb(NEW) ->> 'runtimeTargetId') <> (to_jsonb(NEW) ->> 'previousRuntimeTargetId') AND
					(to_jsonb(NEW) ->> 'runtimePlacementId') IS NOT NULL AND
					(to_jsonb(NEW) ->> 'runtimeRelocationError') IS NULL
				) OR (
					(to_jsonb(OLD) ->> 'runtimeRelocationState') IN ('preparing', 'draining_old', 'failed') AND
					(to_jsonb(NEW) ->> 'runtimeRelocationState') = 'failed' AND
					(to_jsonb(NEW) ->> 'runtimeTargetId') = (to_jsonb(OLD) ->> 'runtimeTargetId') AND
					(to_jsonb(NEW) ->> 'runtimePlacementId') = (to_jsonb(OLD) ->> 'runtimePlacementId') AND
					(to_jsonb(NEW) ->> 'previousRuntimeTargetId') = (to_jsonb(OLD) ->> 'previousRuntimeTargetId') AND
					(to_jsonb(NEW) ->> 'previousRuntimePlacementId') = (to_jsonb(OLD) ->> 'previousRuntimePlacementId') AND
					(to_jsonb(NEW) ->> 'runtimeRelocationId') = (to_jsonb(OLD) ->> 'runtimeRelocationId') AND
					(to_jsonb(NEW) ->> 'runtimeRelocationError') IS NOT NULL
				) OR (
					(to_jsonb(OLD) ->> 'runtimeRelocationState') IN ('draining_old', 'failed') AND
					(to_jsonb(OLD) ->> 'runtimeTargetId') <> (to_jsonb(OLD) ->> 'previousRuntimeTargetId') AND
					(to_jsonb(NEW) ->> 'runtimeTargetId') = (to_jsonb(OLD) ->> 'runtimeTargetId') AND
					(to_jsonb(NEW) ->> 'runtimePlacementId') = (to_jsonb(OLD) ->> 'runtimePlacementId') AND
					(to_jsonb(NEW) ->> 'previousRuntimeTargetId') IS NULL AND
					(to_jsonb(NEW) ->> 'previousRuntimePlacementId') IS NULL AND
					(to_jsonb(NEW) ->> 'runtimeRelocationId') IS NULL AND
					(to_jsonb(NEW) ->> 'runtimeRelocationState') IS NULL AND
					(to_jsonb(NEW) ->> 'runtimeRelocationError') IS NULL
				)
			)
		THEN
			RETURN NEW;
		END IF;
		IF
			(TG_TABLE_NAME = 'deployment' AND current_state IN ('ready', 'done', 'failed', 'error', 'cancelled')) OR
			(TG_TABLE_NAME = 'build' AND current_state IN ('succeeded', 'failed', 'cancelled')) OR
			(TG_TABLE_NAME = 'release' AND current_state IN ('ready', 'failed', 'cancelled', 'retired')) OR
			(TG_TABLE_NAME = 'operation' AND current_state IN ('succeeded', 'failed', 'cancelled')) OR
			(TG_TABLE_NAME = 'providerDelivery' AND current_state IN ('processed', 'ignored', 'failed'))
		THEN
			RAISE EXCEPTION '% % records are immutable', TG_TABLE_NAME, current_state
				USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;

	IF TG_TABLE_NAME = 'operation' AND current_state = 'running' AND next_state = 'pending' THEN
		IF OLD."leaseExpiresAt" IS NOT NULL AND
			OLD."leaseExpiresAt" <= statement_timestamp() AND
			NEW."leaseOwner" IS NULL AND
			NEW."leaseExpiresAt" IS NULL AND
			NEW."fencingToken" = OLD."fencingToken" + 1 AND
			(to_jsonb(NEW) - ARRAY['status', 'leaseOwner', 'leaseExpiresAt', 'fencingToken', 'updatedAt']) IS NOT DISTINCT FROM
			(to_jsonb(OLD) - ARRAY['status', 'leaseOwner', 'leaseExpiresAt', 'fencingToken', 'updatedAt'])
		THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'invalid expired operation claim recovery'
			USING ERRCODE = '23514';
	END IF;

	allowed := CASE TG_TABLE_NAME
		WHEN 'deployment' THEN
			(current_state = 'running' AND next_state IN ('done', 'error', 'cancelled')) OR
			(current_state = 'queued' AND next_state IN ('preparing', 'cancelled')) OR
			(current_state = 'preparing' AND next_state IN ('building', 'deploying', 'failed', 'cancelling')) OR
			(current_state = 'building' AND next_state IN ('deploying', 'failed', 'cancelling')) OR
			(current_state = 'deploying' AND next_state IN ('checking', 'failed', 'cancelling')) OR
			(current_state = 'checking' AND next_state IN ('ready', 'failed', 'cancelling')) OR
			(current_state = 'cancelling' AND next_state IN ('cancelled', 'failed'))
		WHEN 'build' THEN
			(current_state = 'queued' AND next_state IN ('running', 'cancelled')) OR
			(current_state = 'running' AND next_state IN ('succeeded', 'failed', 'cancelled'))
		WHEN 'release' THEN
			(current_state = 'queued' AND next_state IN ('deploying', 'cancelled')) OR
			(current_state = 'deploying' AND next_state IN ('checking', 'failed', 'cancelled')) OR
			(current_state = 'checking' AND next_state IN ('ready', 'failed', 'cancelled')) OR
			(current_state = 'ready' AND next_state = 'retired')
		WHEN 'operation' THEN
			(current_state = 'pending' AND next_state IN ('running', 'cancelled')) OR
			(current_state = 'running' AND next_state IN ('succeeded', 'failed', 'cancelled'))
		WHEN 'alias' THEN
			(current_state = 'pending' AND next_state IN ('ready', 'error', 'disabled')) OR
			(current_state = 'ready' AND next_state IN ('pending', 'disabled')) OR
			(current_state = 'error' AND next_state IN ('pending', 'disabled')) OR
			(current_state = 'disabled' AND next_state = 'pending')
		WHEN 'providerDelivery' THEN
			(current_state = 'received' AND next_state IN ('processing', 'ignored', 'failed')) OR
			(current_state = 'processing' AND next_state IN ('processed', 'ignored', 'failed'))
		ELSE false
	END;

	IF NOT allowed THEN
		RAISE EXCEPTION 'invalid % state transition: % -> %', TG_TABLE_NAME, current_state, next_state
			USING ERRCODE = '23514';
	END IF;
	IF TG_TABLE_NAME = 'release' AND current_state = 'ready' AND
		(to_jsonb(NEW) - ARRAY['status', 'retiredAt']) IS DISTINCT FROM
		(to_jsonb(OLD) - ARRAY['status', 'retiredAt'])
	THEN
		RAISE EXCEPTION 'ready releases may only be retired, never modified'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;