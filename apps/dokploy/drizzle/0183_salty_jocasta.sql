ALTER TABLE "compose" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "libsql" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "libsql" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "mariadb" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "mariadb" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "mongo" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "mongo" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "deletedAt" timestamp with time zone;--> statement-breakpoint

UPDATE "compose" s SET "organizationId" = e."organizationId", "projectId" = e."projectId" FROM "environment" e WHERE e."environmentId" = s."environmentId";--> statement-breakpoint
UPDATE "libsql" s SET "organizationId" = e."organizationId", "projectId" = e."projectId" FROM "environment" e WHERE e."environmentId" = s."environmentId";--> statement-breakpoint
UPDATE "mariadb" s SET "organizationId" = e."organizationId", "projectId" = e."projectId" FROM "environment" e WHERE e."environmentId" = s."environmentId";--> statement-breakpoint
UPDATE "mongo" s SET "organizationId" = e."organizationId", "projectId" = e."projectId" FROM "environment" e WHERE e."environmentId" = s."environmentId";--> statement-breakpoint
UPDATE "mysql" s SET "organizationId" = e."organizationId", "projectId" = e."projectId" FROM "environment" e WHERE e."environmentId" = s."environmentId";--> statement-breakpoint
UPDATE "postgres" s SET "organizationId" = e."organizationId", "projectId" = e."projectId" FROM "environment" e WHERE e."environmentId" = s."environmentId";--> statement-breakpoint
UPDATE "redis" s SET "organizationId" = e."organizationId", "projectId" = e."projectId" FROM "environment" e WHERE e."environmentId" = s."environmentId";--> statement-breakpoint

DO $$
BEGIN
	IF
		EXISTS (SELECT 1 FROM "compose" WHERE "organizationId" IS NULL OR "projectId" IS NULL) OR
		EXISTS (SELECT 1 FROM "libsql" WHERE "organizationId" IS NULL OR "projectId" IS NULL) OR
		EXISTS (SELECT 1 FROM "mariadb" WHERE "organizationId" IS NULL OR "projectId" IS NULL) OR
		EXISTS (SELECT 1 FROM "mongo" WHERE "organizationId" IS NULL OR "projectId" IS NULL) OR
		EXISTS (SELECT 1 FROM "mysql" WHERE "organizationId" IS NULL OR "projectId" IS NULL) OR
		EXISTS (SELECT 1 FROM "postgres" WHERE "organizationId" IS NULL OR "projectId" IS NULL) OR
		EXISTS (SELECT 1 FROM "redis" WHERE "organizationId" IS NULL OR "projectId" IS NULL)
	THEN
		RAISE EXCEPTION 'service ownership backfill found an orphan environment';
	END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "compose" ALTER COLUMN "organizationId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ALTER COLUMN "projectId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "libsql" ALTER COLUMN "organizationId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "libsql" ALTER COLUMN "projectId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mariadb" ALTER COLUMN "organizationId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mariadb" ALTER COLUMN "projectId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mongo" ALTER COLUMN "organizationId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mongo" ALTER COLUMN "projectId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mysql" ALTER COLUMN "organizationId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mysql" ALTER COLUMN "projectId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "postgres" ALTER COLUMN "organizationId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "postgres" ALTER COLUMN "projectId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "redis" ALTER COLUMN "organizationId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "redis" ALTER COLUMN "projectId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_project_organization_fk" FOREIGN KEY ("projectId","organizationId") REFERENCES "public"."project"("projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compose" ADD CONSTRAINT "compose_environment_project_organization_fk" FOREIGN KEY ("environmentId","projectId","organizationId") REFERENCES "public"."environment"("environmentId","projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "libsql" ADD CONSTRAINT "libsql_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "libsql" ADD CONSTRAINT "libsql_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "libsql" ADD CONSTRAINT "libsql_project_organization_fk" FOREIGN KEY ("projectId","organizationId") REFERENCES "public"."project"("projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "libsql" ADD CONSTRAINT "libsql_environment_project_organization_fk" FOREIGN KEY ("environmentId","projectId","organizationId") REFERENCES "public"."environment"("environmentId","projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mariadb" ADD CONSTRAINT "mariadb_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mariadb" ADD CONSTRAINT "mariadb_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mariadb" ADD CONSTRAINT "mariadb_project_organization_fk" FOREIGN KEY ("projectId","organizationId") REFERENCES "public"."project"("projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mariadb" ADD CONSTRAINT "mariadb_environment_project_organization_fk" FOREIGN KEY ("environmentId","projectId","organizationId") REFERENCES "public"."environment"("environmentId","projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mongo" ADD CONSTRAINT "mongo_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mongo" ADD CONSTRAINT "mongo_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mongo" ADD CONSTRAINT "mongo_project_organization_fk" FOREIGN KEY ("projectId","organizationId") REFERENCES "public"."project"("projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mongo" ADD CONSTRAINT "mongo_environment_project_organization_fk" FOREIGN KEY ("environmentId","projectId","organizationId") REFERENCES "public"."environment"("environmentId","projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mysql" ADD CONSTRAINT "mysql_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mysql" ADD CONSTRAINT "mysql_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mysql" ADD CONSTRAINT "mysql_project_organization_fk" FOREIGN KEY ("projectId","organizationId") REFERENCES "public"."project"("projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mysql" ADD CONSTRAINT "mysql_environment_project_organization_fk" FOREIGN KEY ("environmentId","projectId","organizationId") REFERENCES "public"."environment"("environmentId","projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postgres" ADD CONSTRAINT "postgres_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postgres" ADD CONSTRAINT "postgres_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postgres" ADD CONSTRAINT "postgres_project_organization_fk" FOREIGN KEY ("projectId","organizationId") REFERENCES "public"."project"("projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postgres" ADD CONSTRAINT "postgres_environment_project_organization_fk" FOREIGN KEY ("environmentId","projectId","organizationId") REFERENCES "public"."environment"("environmentId","projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redis" ADD CONSTRAINT "redis_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redis" ADD CONSTRAINT "redis_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redis" ADD CONSTRAINT "redis_project_organization_fk" FOREIGN KEY ("projectId","organizationId") REFERENCES "public"."project"("projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redis" ADD CONSTRAINT "redis_environment_project_organization_fk" FOREIGN KEY ("environmentId","projectId","organizationId") REFERENCES "public"."environment"("environmentId","projectId","organizationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compose_id_organization_project_environment_unique" ON "compose" USING btree ("composeId","organizationId","projectId","environmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "libsql_id_organization_project_environment_unique" ON "libsql" USING btree ("libsqlId","organizationId","projectId","environmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "mariadb_id_organization_project_environment_unique" ON "mariadb" USING btree ("mariadbId","organizationId","projectId","environmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "mongo_id_organization_project_environment_unique" ON "mongo" USING btree ("mongoId","organizationId","projectId","environmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "mysql_id_organization_project_environment_unique" ON "mysql" USING btree ("mysqlId","organizationId","projectId","environmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "postgres_id_organization_project_environment_unique" ON "postgres" USING btree ("postgresId","organizationId","projectId","environmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "redis_id_organization_project_environment_unique" ON "redis" USING btree ("redisId","organizationId","projectId","environmentId");--> statement-breakpoint

CREATE OR REPLACE FUNCTION deploytide_reject_server_hard_delete()
RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'server records must be tombstoned, not deleted'
		USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER deploytide_server_hard_delete_guard
BEFORE DELETE ON "server"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_server_hard_delete();--> statement-breakpoint

CREATE OR REPLACE FUNCTION deploytide_reject_retained_hard_delete()
RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% records must be tombstoned, not deleted', TG_TABLE_NAME
		USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER deploytide_organization_hard_delete_guard
BEFORE DELETE ON "organization"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_retained_hard_delete();--> statement-breakpoint
CREATE TRIGGER deploytide_project_hard_delete_guard
BEFORE DELETE ON "project"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_retained_hard_delete();--> statement-breakpoint
CREATE TRIGGER deploytide_environment_hard_delete_guard
BEFORE DELETE ON "environment"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_retained_hard_delete();--> statement-breakpoint
CREATE TRIGGER deploytide_application_hard_delete_guard
BEFORE DELETE ON "application"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_retained_hard_delete();--> statement-breakpoint
CREATE TRIGGER deploytide_deployment_hard_delete_guard
BEFORE DELETE ON "deployment"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_retained_hard_delete();--> statement-breakpoint
CREATE TRIGGER deploytide_domain_hard_delete_guard
BEFORE DELETE ON "domain"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_retained_hard_delete();--> statement-breakpoint
CREATE TRIGGER deploytide_preview_hard_delete_guard
BEFORE DELETE ON "preview_deployments"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_retained_hard_delete();--> statement-breakpoint
CREATE TRIGGER deploytide_rollback_hard_delete_guard
BEFORE DELETE ON "rollback"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_retained_hard_delete();--> statement-breakpoint
CREATE TRIGGER deploytide_environment_variable_hard_delete_guard
BEFORE DELETE ON "environmentVariable"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_retained_hard_delete();