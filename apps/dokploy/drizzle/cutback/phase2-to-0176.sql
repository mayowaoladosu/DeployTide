-- DeployTide Phase 2 cutback rehearsal.
-- Canonical tables are additive; retained legacy rows remain serving-capable.
-- Canonical deployment statuses are mapped back to the four legacy states.

DO $$
BEGIN
	IF (SELECT max(created_at) FROM drizzle.__drizzle_migrations) IS DISTINCT FROM 1785689568547::bigint THEN
		RAISE EXCEPTION 'Phase 2 cutback supports migration head 0183 only';
	END IF;
	IF
		EXISTS (SELECT 1 FROM "organization" WHERE "deleted_at" IS NOT NULL) OR
		EXISTS (SELECT 1 FROM "project" WHERE "deletedAt" IS NOT NULL) OR
		EXISTS (SELECT 1 FROM "environment" WHERE "deletedAt" IS NOT NULL) OR
		EXISTS (SELECT 1 FROM "application" WHERE "deletedAt" IS NOT NULL) OR
		EXISTS (SELECT 1 FROM "compose" WHERE "deletedAt" IS NOT NULL) OR
		EXISTS (SELECT 1 FROM "server" WHERE "deletedAt" IS NOT NULL) OR
		EXISTS (SELECT 1 FROM "deployment" WHERE "deletedAt" IS NOT NULL) OR
		EXISTS (SELECT 1 FROM "domain" WHERE "deletedAt" IS NOT NULL) OR
		EXISTS (SELECT 1 FROM "preview_deployments" WHERE "deletedAt" IS NOT NULL) OR
		EXISTS (SELECT 1 FROM "rollback" WHERE "deletedAt" IS NOT NULL) OR
		EXISTS (SELECT 1 FROM "environmentVariable" WHERE "deletedAt" IS NOT NULL)
	THEN
		RAISE EXCEPTION 'Phase 2 tombstones must be explicitly reconciled before cutback';
	END IF;
	IF
		EXISTS (SELECT 1 FROM "operation" WHERE status IN ('pending', 'running')) OR
		EXISTS (SELECT 1 FROM "outboxEvent" WHERE status IN ('pending', 'processing', 'failed')) OR
		EXISTS (SELECT 1 FROM "build" WHERE status IN ('queued', 'running')) OR
		EXISTS (SELECT 1 FROM "release" WHERE status IN ('queued', 'deploying', 'checking')) OR
		EXISTS (SELECT 1 FROM "providerDelivery" WHERE status IN ('received', 'processing')) OR
		EXISTS (SELECT 1 FROM "alias" WHERE status = 'pending')
	THEN
		RAISE EXCEPTION 'durable Phase 2 work must be drained before cutback';
	END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM "canonicalMigrationIssue"
		WHERE "resourceType" = 'system'
			AND "resourceId" = 'encryption'
			AND code = 'phase1_compatible'
			AND "resolvedAt" IS NULL
	) THEN
		RAISE EXCEPTION 'verified encryption cutback marker is required before Phase 2 SQL cutback';
	END IF;
	IF
		EXISTS (SELECT 1 FROM "project" WHERE "env" LIKE 'enc:v2:%') OR
		EXISTS (SELECT 1 FROM "environment" WHERE "env" LIKE 'enc:v2:%') OR
		EXISTS (SELECT 1 FROM "application" WHERE
			"env" LIKE 'enc:v2:%' OR "previewEnv" LIKE 'enc:v2:%' OR
			"previewBuildArgs" LIKE 'enc:v2:%' OR "previewBuildSecrets" LIKE 'enc:v2:%' OR
			"buildArgs" LIKE 'enc:v2:%' OR "buildSecrets" LIKE 'enc:v2:%' OR
			"refreshToken" LIKE 'enc:%') OR
		EXISTS (SELECT 1 FROM "compose" WHERE
			"env" LIKE 'enc:v2:%' OR "refreshToken" LIKE 'enc:%') OR
		EXISTS (SELECT 1 FROM "postgres" WHERE "env" LIKE 'enc:v2:%') OR
		EXISTS (SELECT 1 FROM "mariadb" WHERE "env" LIKE 'enc:v2:%') OR
		EXISTS (SELECT 1 FROM "mysql" WHERE "env" LIKE 'enc:v2:%') OR
		EXISTS (SELECT 1 FROM "mongo" WHERE "env" LIKE 'enc:v2:%') OR
		EXISTS (SELECT 1 FROM "redis" WHERE "env" LIKE 'enc:v2:%') OR
		EXISTS (SELECT 1 FROM "libsql" WHERE "env" LIKE 'enc:v2:%') OR
		EXISTS (SELECT 1 FROM "account" WHERE
			"access_token" LIKE 'enc:%' OR "refresh_token" LIKE 'enc:%' OR
			"id_token" LIKE 'enc:%' OR "resetPasswordToken" LIKE 'enc:%' OR
			"confirmationToken" LIKE 'enc:%')
	THEN
		RAISE EXCEPTION 'encryption cutback is required before Phase 2 SQL cutback';
	END IF;
END;
$$;--> statement-breakpoint
DROP FUNCTION IF EXISTS deploytide_guard_alias_target() CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS deploytide_guard_release_retirement() CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS deploytide_guard_release_provenance() CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS deploytide_guard_state_transition() CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS deploytide_guard_configuration_snapshot_secret() CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS deploytide_reject_configuration_snapshot_mutation() CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS deploytide_guard_deployment_configuration_snapshot() CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS deploytide_guard_release_configuration_snapshot() CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS deploytide_reject_compose_hard_delete() CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS deploytide_reject_server_hard_delete() CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS deploytide_reject_retained_hard_delete() CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "configurationSnapshotId" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "aliasHistory" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "alias" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "release" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "configurationSnapshotSecretVersion" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "configurationSnapshot" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "artifact" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "build" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "secretVersion" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "environmentVariable" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "branchHead" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "outboxEvent" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "projectSource" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "providerDelivery" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "operation" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "canonicalMigrationIssue" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "deployment_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "environment_id_project_organization_unique" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "project_id_organization_unique" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "application_id_organization_project_environment_unique" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "preview_id_organization_project_environment_unique" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "deployment_id_organization_project_environment_unique" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "deployment_id_organization_project_unique" CASCADE;--> statement-breakpoint

ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "organization_owner_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_provider" ADD CONSTRAINT "scim_provider_scim_token_unique" UNIQUE("scim_token");--> statement-breakpoint
ALTER TABLE "deployment" DROP CONSTRAINT IF EXISTS "deployment_rollbackId_rollback_rollbackId_fk";--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_rollbackId_rollback_rollbackId_fk" FOREIGN KEY ("rollbackId") REFERENCES "public"."rollback"("rollbackId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ALTER COLUMN "metricsConfig" SET DEFAULT '{"server":{"type":"Remote","refreshRate":60,"port":4500,"token":"","urlCallback":"","cronJob":"","retentionDays":2,"thresholds":{"cpu":0,"memory":0}},"containers":{"refreshRate":60,"services":{"include":[],"exclude":[]}}}'::jsonb;--> statement-breakpoint
ALTER TABLE "webServerSettings" ALTER COLUMN "metricsConfig" SET DEFAULT '{"server":{"type":"Dokploy","refreshRate":60,"port":4500,"token":"","retentionDays":2,"cronJob":"","urlCallback":"","thresholds":{"cpu":0,"memory":0}},"containers":{"refreshRate":60,"services":{"include":[],"exclude":[]}}}'::jsonb;--> statement-breakpoint

ALTER TABLE "rollback" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "rollback" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "rollback" DROP COLUMN IF EXISTS "environmentId" CASCADE;--> statement-breakpoint
ALTER TABLE "rollback" DROP COLUMN IF EXISTS "deletedAt" CASCADE;--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN IF EXISTS "deleted_at" CASCADE;--> statement-breakpoint
ALTER TABLE "domain" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "domain" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "domain" DROP COLUMN IF EXISTS "environmentId" CASCADE;--> statement-breakpoint
ALTER TABLE "domain" DROP COLUMN IF EXISTS "deletedAt" CASCADE;--> statement-breakpoint
ALTER TABLE "preview_deployments" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "preview_deployments" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "preview_deployments" DROP COLUMN IF EXISTS "environmentId" CASCADE;--> statement-breakpoint
ALTER TABLE "preview_deployments" DROP COLUMN IF EXISTS "deletedAt" CASCADE;--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN IF EXISTS "primaryApplicationId" CASCADE;--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN IF EXISTS "deletedAt" CASCADE;--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "deletedAt" CASCADE;--> statement-breakpoint
ALTER TABLE "application" DROP COLUMN IF EXISTS "refreshTokenDigest" CASCADE;--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "refreshTokenDigest" CASCADE;--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "deletedAt" CASCADE;--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "compose" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "postgres" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "postgres" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "mariadb" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "mariadb" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "mysql" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "mysql" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "mongo" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "mongo" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "redis" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "redis" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "libsql" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "libsql" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "server" DROP COLUMN IF EXISTS "deletedAt" CASCADE;--> statement-breakpoint

ALTER TABLE "deployment" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "projectId" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "environmentId" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "trigger" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "sourceProvider" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "sourceRevision" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "sourceBranch" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "sourceAuthor" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "sourceMessage" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "desiredSequence" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "immutableUrl" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "sourceConfigSnapshot" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "buildConfigSnapshot" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "runtimeConfigSnapshot" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "errorCode" CASCADE;--> statement-breakpoint
ALTER TABLE "deployment" DROP COLUMN IF EXISTS "deletedAt" CASCADE;--> statement-breakpoint

ALTER TABLE "environment" DROP COLUMN IF EXISTS "organizationId" CASCADE;--> statement-breakpoint
ALTER TABLE "environment" DROP COLUMN IF EXISTS "kind" CASCADE;--> statement-breakpoint
ALTER TABLE "environment" DROP COLUMN IF EXISTS "branchPattern" CASCADE;--> statement-breakpoint
ALTER TABLE "environment" DROP COLUMN IF EXISTS "protectionPolicy" CASCADE;--> statement-breakpoint
ALTER TABLE "environment" DROP COLUMN IF EXISTS "retentionDays" CASCADE;--> statement-breakpoint
ALTER TABLE "environment" DROP COLUMN IF EXISTS "deletedAt" CASCADE;--> statement-breakpoint

ALTER TABLE "deployment" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "deployment" ALTER COLUMN "status" TYPE text USING "status"::text;--> statement-breakpoint
UPDATE "deployment"
SET "status" = CASE
	WHEN "status" IN ('queued', 'preparing', 'building', 'deploying', 'checking', 'cancelling') THEN 'running'
	WHEN "status" = 'ready' THEN 'done'
	WHEN "status" = 'failed' THEN 'error'
	ELSE "status"
END;--> statement-breakpoint
DROP TYPE IF EXISTS "deploymentStatus";--> statement-breakpoint
CREATE TYPE "deploymentStatus" AS ENUM('running', 'done', 'error', 'cancelled');--> statement-breakpoint
ALTER TABLE "deployment" ALTER COLUMN "status" TYPE "deploymentStatus" USING "status"::"deploymentStatus";--> statement-breakpoint
ALTER TABLE "deployment" ALTER COLUMN "status" SET DEFAULT 'running'::"deploymentStatus";--> statement-breakpoint

DROP TYPE IF EXISTS "aliasKind";--> statement-breakpoint
DROP TYPE IF EXISTS "aliasStatus";--> statement-breakpoint
DROP TYPE IF EXISTS "artifactStatus";--> statement-breakpoint
DROP TYPE IF EXISTS "artifactType";--> statement-breakpoint
DROP TYPE IF EXISTS "buildStatus";--> statement-breakpoint
DROP TYPE IF EXISTS "deploymentTrigger";--> statement-breakpoint
DROP TYPE IF EXISTS "environmentKind";--> statement-breakpoint
DROP TYPE IF EXISTS "variableExposure";--> statement-breakpoint
DROP TYPE IF EXISTS "variableScope";--> statement-breakpoint
DROP TYPE IF EXISTS "operationActorType";--> statement-breakpoint
DROP TYPE IF EXISTS "operationStatus";--> statement-breakpoint
DROP TYPE IF EXISTS "outboxEventStatus";--> statement-breakpoint
DROP TYPE IF EXISTS "projectSourceProvider";--> statement-breakpoint
DROP TYPE IF EXISTS "deliveryProvider";--> statement-breakpoint
DROP TYPE IF EXISTS "providerDeliveryStatus";--> statement-breakpoint
DROP TYPE IF EXISTS "releaseStatus";--> statement-breakpoint

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at IN (
	1785664162094,
	1785664303391,
	1785666854713,
	1785684550226,
	1785687432136,
	1785687811977,
	1785689568547
);--> statement-breakpoint
