CREATE TABLE "configurationSnapshot" (
	"configurationSnapshotId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"projectId" text NOT NULL,
	"environmentId" text NOT NULL,
	"serviceType" text NOT NULL,
	"serviceId" text NOT NULL,
	"schemaVersion" integer DEFAULT 1 NOT NULL,
	"sourceConfig" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"buildConfig" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtimeConfig" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contentDigest" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "configurationSnapshotSecretVersion" (
	"configurationSnapshotId" text NOT NULL,
	"organizationId" text NOT NULL,
	"environmentVariableId" text NOT NULL,
	"secretVersionId" text NOT NULL,
	"key" text NOT NULL,
	"exposure" "variableExposure" NOT NULL,
	CONSTRAINT "configuration_snapshot_secret_key_pk" PRIMARY KEY("configurationSnapshotId","key")
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "configurationSnapshotId" text;--> statement-breakpoint
ALTER TABLE "release" ADD COLUMN "configurationSnapshotId" text;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_variable_id_organization_unique" ON "environmentVariable" USING btree ("environmentVariableId","organizationId");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_version_id_variable_unique" ON "secretVersion" USING btree ("secretVersionId","environmentVariableId");--> statement-breakpoint
CREATE UNIQUE INDEX "configuration_snapshot_id_ownership_unique" ON "configurationSnapshot" USING btree ("configurationSnapshotId","organizationId","projectId","environmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "configuration_snapshot_id_organization_unique" ON "configurationSnapshot" USING btree ("configurationSnapshotId","organizationId");--> statement-breakpoint
ALTER TABLE "configurationSnapshot" ADD CONSTRAINT "configurationSnapshot_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurationSnapshot" ADD CONSTRAINT "configurationSnapshot_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurationSnapshot" ADD CONSTRAINT "configurationSnapshot_environmentId_environment_environmentId_fk" FOREIGN KEY ("environmentId") REFERENCES "public"."environment"("environmentId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurationSnapshot" ADD CONSTRAINT "configuration_snapshot_project_organization_fk" FOREIGN KEY ("projectId","organizationId") REFERENCES "public"."project"("projectId","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurationSnapshot" ADD CONSTRAINT "configuration_snapshot_environment_ownership_fk" FOREIGN KEY ("environmentId","projectId","organizationId") REFERENCES "public"."environment"("environmentId","projectId","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "configuration_snapshot_environment_created_idx" ON "configurationSnapshot" USING btree ("environmentId","createdAt");--> statement-breakpoint
CREATE INDEX "configuration_snapshot_service_idx" ON "configurationSnapshot" USING btree ("serviceType","serviceId","createdAt");--> statement-breakpoint

INSERT INTO "configurationSnapshot" (
	"configurationSnapshotId", "organizationId", "projectId", "environmentId",
	"serviceType", "serviceId", "schemaVersion", "sourceConfig", "buildConfig",
	"runtimeConfig", "contentDigest", "createdAt"
)
SELECT
	'legacy_' || md5(d."deploymentId"),
	d."organizationId",
	d."projectId",
	d."environmentId",
	CASE
		WHEN d."applicationId" IS NOT NULL THEN 'application'
		WHEN d."composeId" IS NOT NULL THEN 'compose'
		WHEN d."previewDeploymentId" IS NOT NULL THEN 'preview'
		WHEN d."backupId" IS NOT NULL THEN 'backup'
		WHEN d."volumeBackupId" IS NOT NULL THEN 'volume-backup'
		WHEN d."scheduleId" IS NOT NULL THEN 'schedule'
		ELSE 'legacy'
	END,
	COALESCE(
		d."applicationId", d."composeId", d."previewDeploymentId", d."backupId",
		d."volumeBackupId", d."scheduleId", d."deploymentId"
	),
	0,
	COALESCE(d."sourceConfigSnapshot", '{}'::jsonb),
	COALESCE(d."buildConfigSnapshot", '{}'::jsonb),
	COALESCE(d."runtimeConfigSnapshot", '{}'::jsonb),
	'legacy:' || md5(
		d."deploymentId" || ':' ||
		COALESCE(d."sourceConfigSnapshot", '{}'::jsonb)::text || ':' ||
		COALESCE(d."buildConfigSnapshot", '{}'::jsonb)::text || ':' ||
		COALESCE(d."runtimeConfigSnapshot", '{}'::jsonb)::text
	),
	COALESCE(NULLIF(d."createdAt", '')::timestamptz, now())
FROM "deployment" d
WHERE d."organizationId" IS NOT NULL
	AND d."projectId" IS NOT NULL
	AND d."environmentId" IS NOT NULL
ON CONFLICT ("configurationSnapshotId") DO NOTHING;--> statement-breakpoint

ALTER TABLE "deployment" DISABLE TRIGGER deploytide_deployment_state_guard;--> statement-breakpoint
UPDATE "deployment" d
SET "configurationSnapshotId" = 'legacy_' || md5(d."deploymentId")
WHERE d."configurationSnapshotId" IS NULL
	AND d."organizationId" IS NOT NULL
	AND d."projectId" IS NOT NULL
	AND d."environmentId" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ENABLE TRIGGER deploytide_deployment_state_guard;--> statement-breakpoint

ALTER TABLE "release" DISABLE TRIGGER deploytide_release_state_guard;--> statement-breakpoint
UPDATE "release" r
SET "configurationSnapshotId" = d."configurationSnapshotId"
FROM "deployment" d
WHERE d."deploymentId" = r."deploymentId"
	AND d."organizationId" = r."organizationId"
	AND d."projectId" = r."projectId"
	AND d."environmentId" = r."environmentId";--> statement-breakpoint
ALTER TABLE "release" ENABLE TRIGGER deploytide_release_state_guard;--> statement-breakpoint

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "release" WHERE "configurationSnapshotId" IS NULL) THEN
		RAISE EXCEPTION 'cannot migrate releases without an owned deployment configuration snapshot';
	END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "release" ALTER COLUMN "configurationSnapshotId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_configurationSnapshotId_configurationSnapshot_configurationSnapshotId_fk" FOREIGN KEY ("configurationSnapshotId") REFERENCES "public"."configurationSnapshot"("configurationSnapshotId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_configuration_snapshot_ownership_fk" FOREIGN KEY ("configurationSnapshotId","organizationId","projectId","environmentId") REFERENCES "public"."configurationSnapshot"("configurationSnapshotId","organizationId","projectId","environmentId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_configurationSnapshotId_configurationSnapshot_configurationSnapshotId_fk" FOREIGN KEY ("configurationSnapshotId") REFERENCES "public"."configurationSnapshot"("configurationSnapshotId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_configuration_snapshot_ownership_fk" FOREIGN KEY ("configurationSnapshotId","organizationId","projectId","environmentId") REFERENCES "public"."configurationSnapshot"("configurationSnapshotId","organizationId","projectId","environmentId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployment_configuration_snapshot_idx" ON "deployment" USING btree ("configurationSnapshotId");--> statement-breakpoint
CREATE INDEX "release_configuration_snapshot_idx" ON "release" USING btree ("configurationSnapshotId");--> statement-breakpoint
CREATE UNIQUE INDEX "configuration_snapshot_secret_version_unique" ON "configurationSnapshotSecretVersion" USING btree ("configurationSnapshotId","secretVersionId");--> statement-breakpoint
CREATE INDEX "configuration_snapshot_secret_version_idx" ON "configurationSnapshotSecretVersion" USING btree ("secretVersionId");--> statement-breakpoint
ALTER TABLE "configurationSnapshotSecretVersion" ADD CONSTRAINT "configuration_snapshot_secret_snapshot_fk" FOREIGN KEY ("configurationSnapshotId","organizationId") REFERENCES "public"."configurationSnapshot"("configurationSnapshotId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurationSnapshotSecretVersion" ADD CONSTRAINT "configuration_snapshot_secret_variable_fk" FOREIGN KEY ("environmentVariableId","organizationId") REFERENCES "public"."environmentVariable"("environmentVariableId","organizationId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurationSnapshotSecretVersion" ADD CONSTRAINT "configuration_snapshot_secret_exact_version_fk" FOREIGN KEY ("secretVersionId","environmentVariableId") REFERENCES "public"."secretVersion"("secretVersionId","environmentVariableId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE OR REPLACE FUNCTION deploytide_guard_configuration_snapshot_secret()
RETURNS trigger AS $$
DECLARE
	snapshot_record record;
	variable_record record;
BEGIN
	SELECT "organizationId", "projectId", "environmentId"
	INTO snapshot_record
	FROM "configurationSnapshot"
	WHERE "configurationSnapshotId" = NEW."configurationSnapshotId";

	SELECT "organizationId", "projectId", "environmentId", "scope", "key", "exposure"
	INTO variable_record
	FROM "environmentVariable"
	WHERE "environmentVariableId" = NEW."environmentVariableId";

	IF snapshot_record IS NULL OR variable_record IS NULL
		OR snapshot_record."organizationId" IS DISTINCT FROM variable_record."organizationId"
		OR NEW."organizationId" IS DISTINCT FROM snapshot_record."organizationId"
		OR NEW."key" IS DISTINCT FROM variable_record."key"
		OR NEW."exposure" IS DISTINCT FROM variable_record."exposure"
		OR (variable_record."scope" = 'project' AND variable_record."projectId" IS DISTINCT FROM snapshot_record."projectId")
		OR (variable_record."scope" = 'environment' AND (
			variable_record."projectId" IS DISTINCT FROM snapshot_record."projectId"
			OR variable_record."environmentId" IS DISTINCT FROM snapshot_record."environmentId"
		))
	THEN
		RAISE EXCEPTION 'configuration snapshot secret is outside snapshot scope';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER deploytide_configuration_snapshot_secret_scope_guard
BEFORE INSERT OR UPDATE ON "configurationSnapshotSecretVersion"
FOR EACH ROW EXECUTE FUNCTION deploytide_guard_configuration_snapshot_secret();--> statement-breakpoint

CREATE OR REPLACE FUNCTION deploytide_reject_configuration_snapshot_mutation()
RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'configuration snapshots are immutable';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER deploytide_configuration_snapshot_immutable
BEFORE UPDATE OR DELETE ON "configurationSnapshot"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_configuration_snapshot_mutation();--> statement-breakpoint

CREATE TRIGGER deploytide_configuration_snapshot_secret_immutable
BEFORE UPDATE OR DELETE ON "configurationSnapshotSecretVersion"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_configuration_snapshot_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION deploytide_guard_deployment_configuration_snapshot()
RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW."organizationId" IS NOT NULL AND NEW."projectId" IS NOT NULL
			AND NEW."environmentId" IS NOT NULL AND NEW."configurationSnapshotId" IS NULL THEN
			RAISE EXCEPTION 'project deployments require a configuration snapshot';
		END IF;
	ELSIF OLD."configurationSnapshotId" IS DISTINCT FROM NEW."configurationSnapshotId"
		OR OLD."sourceConfigSnapshot" IS DISTINCT FROM NEW."sourceConfigSnapshot"
		OR OLD."buildConfigSnapshot" IS DISTINCT FROM NEW."buildConfigSnapshot"
		OR OLD."runtimeConfigSnapshot" IS DISTINCT FROM NEW."runtimeConfigSnapshot" THEN
		RAISE EXCEPTION 'deployment configuration provenance is immutable';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER deploytide_deployment_configuration_snapshot_guard
BEFORE INSERT OR UPDATE OF "configurationSnapshotId", "sourceConfigSnapshot", "buildConfigSnapshot", "runtimeConfigSnapshot"
ON "deployment" FOR EACH ROW EXECUTE FUNCTION deploytide_guard_deployment_configuration_snapshot();--> statement-breakpoint

CREATE OR REPLACE FUNCTION deploytide_guard_release_configuration_snapshot()
RETURNS trigger AS $$
DECLARE
	expected_snapshot_id text;
BEGIN
	SELECT d."configurationSnapshotId"
	INTO expected_snapshot_id
	FROM "deployment" d
	WHERE d."deploymentId" = NEW."deploymentId"
		AND d."organizationId" = NEW."organizationId"
		AND d."projectId" = NEW."projectId"
		AND d."environmentId" = NEW."environmentId";

	IF expected_snapshot_id IS NULL THEN
		RAISE EXCEPTION 'release deployment has no configuration snapshot';
	END IF;
	IF NEW."configurationSnapshotId" IS NULL THEN
		NEW."configurationSnapshotId" := expected_snapshot_id;
	ELSIF NEW."configurationSnapshotId" IS DISTINCT FROM expected_snapshot_id THEN
		RAISE EXCEPTION 'release configuration snapshot must match its deployment';
	END IF;
	IF TG_OP = 'UPDATE' AND OLD."configurationSnapshotId" IS DISTINCT FROM NEW."configurationSnapshotId" THEN
		RAISE EXCEPTION 'release configuration snapshot is immutable';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER deploytide_release_configuration_snapshot_guard
BEFORE INSERT OR UPDATE OF "configurationSnapshotId", "deploymentId", "organizationId", "projectId", "environmentId"
ON "release" FOR EACH ROW EXECUTE FUNCTION deploytide_guard_release_configuration_snapshot();