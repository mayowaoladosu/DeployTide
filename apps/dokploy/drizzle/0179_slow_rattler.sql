ALTER TABLE "application" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "deletedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "environmentId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "deletedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "secretVersion" ADD COLUMN "operationId" text;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "environmentId" text;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "deletedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rollback" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "rollback" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "rollback" ADD COLUMN "environmentId" text;--> statement-breakpoint
ALTER TABLE "rollback" ADD COLUMN "deletedAt" timestamp with time zone;--> statement-breakpoint
UPDATE "application" AS a
SET
	"organizationId" = p."organizationId",
	"projectId" = p."projectId"
FROM "environment" AS e
INNER JOIN "project" AS p ON p."projectId" = e."projectId"
WHERE a."environmentId" = e."environmentId";--> statement-breakpoint
ALTER TABLE "application" ALTER COLUMN "organizationId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ALTER COLUMN "projectId" SET NOT NULL;--> statement-breakpoint
UPDATE "preview_deployments" AS preview
SET
	"organizationId" = a."organizationId",
	"projectId" = a."projectId",
	"environmentId" = a."environmentId"
FROM "application" AS a
WHERE preview."applicationId" = a."applicationId";--> statement-breakpoint
ALTER TABLE "preview_deployments" ALTER COLUMN "organizationId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployments" ALTER COLUMN "projectId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployments" ALTER COLUMN "environmentId" SET NOT NULL;--> statement-breakpoint
UPDATE "domain" AS d
SET
	"organizationId" = a."organizationId",
	"projectId" = a."projectId",
	"environmentId" = a."environmentId"
FROM "application" AS a
WHERE d."applicationId" = a."applicationId"
	AND num_nonnulls(d."applicationId", d."composeId", d."previewDeploymentId") = 1;--> statement-breakpoint
UPDATE "domain" AS d
SET
	"organizationId" = p."organizationId",
	"projectId" = p."projectId",
	"environmentId" = e."environmentId"
FROM "compose" AS c
INNER JOIN "environment" AS e ON e."environmentId" = c."environmentId"
INNER JOIN "project" AS p ON p."projectId" = e."projectId"
WHERE d."composeId" = c."composeId"
	AND d."organizationId" IS NULL
	AND num_nonnulls(d."applicationId", d."composeId", d."previewDeploymentId") = 1;--> statement-breakpoint
UPDATE "domain" AS d
SET
	"organizationId" = preview."organizationId",
	"projectId" = preview."projectId",
	"environmentId" = preview."environmentId"
FROM "preview_deployments" AS preview
WHERE d."previewDeploymentId" = preview."previewDeploymentId"
	AND d."organizationId" IS NULL
	AND num_nonnulls(d."applicationId", d."composeId", d."previewDeploymentId") = 1;--> statement-breakpoint
UPDATE "rollback" AS rb
SET
	"organizationId" = d."organizationId",
	"projectId" = d."projectId",
	"environmentId" = d."environmentId",
	"fullContext" = NULL
FROM "deployment" AS d
WHERE rb."deploymentId" = d."deploymentId";--> statement-breakpoint
UPDATE "rollback" SET "fullContext" = NULL WHERE "fullContext" IS NOT NULL;--> statement-breakpoint
INSERT INTO "canonicalMigrationIssue" (
	"migrationIssueId",
	"organizationId",
	"resourceType",
	"resourceId",
	"code",
	"details"
)
SELECT
	'migration_' || md5(d."domainId" || ':missing-ownership'),
	d."organizationId",
	'domain',
	d."domainId",
	'missing_canonical_ownership',
	jsonb_strip_nulls(jsonb_build_object(
		'applicationId', d."applicationId",
		'composeId', d."composeId",
		'previewDeploymentId', d."previewDeploymentId"
	))
FROM "domain" AS d
WHERE d."organizationId" IS NULL
	OR d."projectId" IS NULL
	OR d."environmentId" IS NULL
ON CONFLICT ("resourceType", "resourceId", "code") DO NOTHING;--> statement-breakpoint
INSERT INTO "canonicalMigrationIssue" (
	"migrationIssueId",
	"organizationId",
	"resourceType",
	"resourceId",
	"code",
	"details"
)
SELECT
	'migration_' || md5(rb."rollbackId" || ':missing-ownership'),
	rb."organizationId",
	'rollback',
	rb."rollbackId",
	'missing_canonical_ownership',
	jsonb_build_object('deploymentId', rb."deploymentId")
FROM "rollback" AS rb
WHERE rb."organizationId" IS NULL
	OR rb."projectId" IS NULL
	OR rb."environmentId" IS NULL
ON CONFLICT ("resourceType", "resourceId", "code") DO NOTHING;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branchHead" ADD CONSTRAINT "branchHead_providerDeliveryId_providerDelivery_providerDeliveryId_fk" FOREIGN KEY ("providerDeliveryId") REFERENCES "public"."providerDelivery"("providerDeliveryId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_environmentId_environment_environmentId_fk" FOREIGN KEY ("environmentId") REFERENCES "public"."environment"("environmentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secretVersion" ADD CONSTRAINT "secretVersion_operationId_operation_operationId_fk" FOREIGN KEY ("operationId") REFERENCES "public"."operation"("operationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_environmentId_environment_environmentId_fk" FOREIGN KEY ("environmentId") REFERENCES "public"."environment"("environmentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollback" ADD CONSTRAINT "rollback_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollback" ADD CONSTRAINT "rollback_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollback" ADD CONSTRAINT "rollback_environmentId_environment_environmentId_fk" FOREIGN KEY ("environmentId") REFERENCES "public"."environment"("environmentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providerDelivery" DROP COLUMN "payload";--> statement-breakpoint
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
$$;--> statement-breakpoint
CREATE TRIGGER deploytide_deployment_state_guard BEFORE UPDATE ON "deployment" FOR EACH ROW EXECUTE FUNCTION deploytide_guard_state_transition();--> statement-breakpoint
CREATE TRIGGER deploytide_build_state_guard BEFORE UPDATE ON "build" FOR EACH ROW EXECUTE FUNCTION deploytide_guard_state_transition();--> statement-breakpoint
CREATE TRIGGER deploytide_release_state_guard BEFORE UPDATE ON "release" FOR EACH ROW EXECUTE FUNCTION deploytide_guard_state_transition();--> statement-breakpoint
CREATE TRIGGER deploytide_operation_state_guard BEFORE UPDATE ON "operation" FOR EACH ROW EXECUTE FUNCTION deploytide_guard_state_transition();--> statement-breakpoint
CREATE TRIGGER deploytide_alias_state_guard BEFORE UPDATE ON "alias" FOR EACH ROW EXECUTE FUNCTION deploytide_guard_state_transition();--> statement-breakpoint
CREATE TRIGGER deploytide_provider_delivery_state_guard BEFORE UPDATE ON "providerDelivery" FOR EACH ROW EXECUTE FUNCTION deploytide_guard_state_transition();--> statement-breakpoint
CREATE OR REPLACE FUNCTION deploytide_guard_alias_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."releaseId" IS NULL AND NEW.status = 'ready' THEN
		RAISE EXCEPTION 'ready aliases require a ready release target'
			USING ERRCODE = '23514';
	END IF;
	IF NEW."releaseId" IS NULL THEN
		RETURN NEW;
	END IF;
	IF NEW.status = 'disabled' THEN
		RETURN NEW;
	END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM "release" AS r
		WHERE r."releaseId" = NEW."releaseId"
			AND r."organizationId" = NEW."organizationId"
			AND r."projectId" = NEW."projectId"
			AND r."environmentId" = NEW."environmentId"
			AND r.status = 'ready'
	) THEN
		RAISE EXCEPTION 'aliases may only target ready releases in the same workspace, project, and environment'
			USING ERRCODE = '23514';
	END IF;
	IF TG_OP = 'UPDATE' AND OLD.kind = 'immutable' AND OLD."releaseId" IS NOT NULL AND OLD."releaseId" IS DISTINCT FROM NEW."releaseId" THEN
		RAISE EXCEPTION 'immutable aliases cannot be moved'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER deploytide_alias_target_guard BEFORE INSERT OR UPDATE OF "releaseId", "organizationId", "projectId", "environmentId", kind, status ON "alias" FOR EACH ROW EXECUTE FUNCTION deploytide_guard_alias_target();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION deploytide_guard_release_retirement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.status = 'retired' AND OLD.status IS DISTINCT FROM NEW.status AND EXISTS (
		SELECT 1
		FROM "alias" AS a
		WHERE a."releaseId" = NEW."releaseId"
			AND a.status <> 'disabled'
	) THEN
		RAISE EXCEPTION 'a release targeted by an active alias cannot be retired'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER deploytide_release_retirement_guard BEFORE UPDATE OF status ON "release" FOR EACH ROW EXECUTE FUNCTION deploytide_guard_release_retirement();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION deploytide_guard_release_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM "artifact" AS a
		INNER JOIN "build" AS b ON b."buildId" = a."buildId"
		WHERE a."artifactId" = NEW."artifactId"
			AND a."organizationId" = NEW."organizationId"
			AND a."projectId" = NEW."projectId"
			AND b."deploymentId" = NEW."deploymentId"
			AND b."organizationId" = NEW."organizationId"
			AND b."projectId" = NEW."projectId"
	) THEN
		RAISE EXCEPTION 'release artifact must originate from the release deployment'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER deploytide_release_provenance_guard BEFORE INSERT OR UPDATE OF "artifactId", "deploymentId", "organizationId", "projectId" ON "release" FOR EACH ROW EXECUTE FUNCTION deploytide_guard_release_provenance();