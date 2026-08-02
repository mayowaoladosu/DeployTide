CREATE TABLE "canonicalMigrationIssue" (
	"migrationIssueId" text PRIMARY KEY NOT NULL,
	"organizationId" text,
	"resourceType" text NOT NULL,
	"resourceId" text NOT NULL,
	"code" text NOT NULL,
	"details" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"resolvedAt" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "environment_variable_scope_key_unique";--> statement-breakpoint
INSERT INTO "projectSource" (
	"projectSourceId",
	"organizationId",
	"projectId",
	"provider",
	"connectionId",
	"repositoryOwner",
	"repositoryName",
	"repositoryId",
	"defaultBranch",
	"rootDirectory",
	"autoDeployPolicy",
	"enabled"
)
SELECT
	'source_' || md5(p."projectId"),
	p."organizationId",
	p."projectId",
	CASE a."sourceType"::text
		WHEN 'docker' THEN 'container'::"projectSourceProvider"
		WHEN 'drop' THEN 'upload'::"projectSourceProvider"
		ELSE a."sourceType"::text::"projectSourceProvider"
	END,
	COALESCE(a."githubId", a."gitlabId", a."bitbucketId", a."giteaId", a."customGitSSHKeyId"),
	COALESCE(a."owner", a."gitlabOwner", a."bitbucketOwner", a."giteaOwner"),
	COALESCE(
		a."repository", a."gitlabRepository", a."bitbucketRepository", a."giteaRepository", a."dockerImage",
		CASE WHEN a."customGitUrl" ~ '^[A-Za-z][A-Za-z0-9+.-]*://([^/@]+@|.*[?#])' THEN NULL ELSE a."customGitUrl" END
	),
	COALESCE(
		a."repository", a."gitlabProjectId"::text, a."bitbucketRepositorySlug", a."giteaRepository", a."dockerImage",
		CASE WHEN a."customGitUrl" ~ '^[A-Za-z][A-Za-z0-9+.-]*://([^/@]+@|.*[?#])' THEN NULL ELSE a."customGitUrl" END
	),
	COALESCE(a."branch", a."gitlabBranch", a."bitbucketBranch", a."giteaBranch", a."customGitBranch", 'main'),
	COALESCE(a."buildPath", a."gitlabBuildPath", a."bitbucketBuildPath", a."giteaBuildPath", a."customGitBuildPath", a."dropBuildPath", ''),
	jsonb_build_object(
		'enabled', COALESCE(a."autoDeploy", true),
		'productionBranch', COALESCE(a."branch", a."gitlabBranch", a."bitbucketBranch", a."giteaBranch", a."customGitBranch", 'main'),
		'previewBranches', COALESCE(a."isPreviewDeploymentsActive", false),
		'watchPaths', COALESCE(to_jsonb(a."watchPaths"), '[]'::jsonb)
	),
	true
FROM "project" AS p
INNER JOIN "application" AS a
	ON a."applicationId" = p."primaryApplicationId"
ON CONFLICT ("projectId") DO NOTHING;--> statement-breakpoint
INSERT INTO "canonicalMigrationIssue" (
	"migrationIssueId", "organizationId", "resourceType", "resourceId", code, details
)
SELECT
	'migration_' || md5(a."applicationId" || ':credential-bearing-source-url'),
	p."organizationId",
	'application',
	a."applicationId",
	'credential_bearing_source_url',
	jsonb_build_object('sourceType', a."sourceType"::text)
FROM "application" AS a
INNER JOIN "environment" AS e ON e."environmentId" = a."environmentId"
INNER JOIN "project" AS p ON p."projectId" = e."projectId"
WHERE a."customGitUrl" ~ '^[A-Za-z][A-Za-z0-9+.-]*://([^/@]+@|.*[?#])';--> statement-breakpoint
INSERT INTO "canonicalMigrationIssue" (
	"migrationIssueId", "organizationId", "resourceType", "resourceId", code, details
)
SELECT
	'migration_' || md5(c."composeId" || ':credential-bearing-source-url'),
	p."organizationId",
	'compose',
	c."composeId",
	'credential_bearing_source_url',
	jsonb_build_object('sourceType', c."sourceType"::text)
FROM "compose" AS c
INNER JOIN "environment" AS e ON e."environmentId" = c."environmentId"
INNER JOIN "project" AS p ON p."projectId" = e."projectId"
WHERE c."customGitUrl" ~ '^[A-Za-z][A-Za-z0-9+.-]*://([^/@]+@|.*[?#])';--> statement-breakpoint
INSERT INTO "canonicalMigrationIssue" (
	"migrationIssueId",
	"organizationId",
	"resourceType",
	"resourceId",
	"code",
	"details"
)
SELECT
	'migration_' || md5(d."deploymentId" || ':missing-ownership'),
	d."organizationId",
	'deployment',
	d."deploymentId",
	'missing_canonical_ownership',
	jsonb_strip_nulls(jsonb_build_object(
		'applicationId', d."applicationId",
		'composeId', d."composeId",
		'serverId', d."serverId",
		'scheduleId', d."scheduleId",
		'backupId', d."backupId",
		'volumeBackupId', d."volumeBackupId"
	))
FROM "deployment" AS d
WHERE d."organizationId" IS NULL
	OR (
		(d."applicationId" IS NOT NULL OR d."composeId" IS NOT NULL OR d."previewDeploymentId" IS NOT NULL)
		AND (d."projectId" IS NULL OR d."environmentId" IS NULL)
	);--> statement-breakpoint
INSERT INTO "canonicalMigrationIssue" (
	"migrationIssueId",
	"organizationId",
	"resourceType",
	"resourceId",
	"code",
	"details"
)
SELECT
	'migration_' || md5(d."deploymentId" || ':missing-source-revision'),
	d."organizationId",
	'deployment',
	d."deploymentId",
	'missing_source_revision',
	jsonb_build_object(
		'sourceProvider', d."sourceProvider",
		'sourceBranch', d."sourceBranch"
	)
FROM "deployment" AS d
WHERE d."projectId" IS NOT NULL
	AND d."sourceProvider" IN ('github', 'gitlab', 'bitbucket', 'gitea', 'git')
	AND d."sourceRevision" IS NULL;--> statement-breakpoint
ALTER TABLE "environment" ALTER COLUMN "organizationId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "canonicalMigrationIssue" ADD CONSTRAINT "canonicalMigrationIssue_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_migration_issue_resource_unique" ON "canonicalMigrationIssue" USING btree ("resourceType","resourceId","code");--> statement-breakpoint
CREATE INDEX "canonical_migration_issue_open_idx" ON "canonicalMigrationIssue" USING btree ("resolvedAt","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_one_production_per_project_unique" ON "environment" USING btree ("projectId") WHERE "environment"."kind" = 'production' AND "environment"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_variable_workspace_key_unique" ON "environmentVariable" USING btree ("organizationId","key") WHERE "environmentVariable"."scope" = 'workspace' AND "environmentVariable"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_variable_project_key_unique" ON "environmentVariable" USING btree ("organizationId","projectId","key") WHERE "environmentVariable"."scope" = 'project' AND "environmentVariable"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_variable_environment_key_unique" ON "environmentVariable" USING btree ("organizationId","environmentId","key") WHERE "environmentVariable"."scope" = 'environment' AND "environmentVariable"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "environment_variable_scope_idx" ON "environmentVariable" USING btree ("organizationId","scope");--> statement-breakpoint
ALTER TABLE "environmentVariable" ADD CONSTRAINT "environment_variable_scope_target_check" CHECK ((
				("environmentVariable"."scope" = 'workspace' AND "environmentVariable"."projectId" IS NULL AND "environmentVariable"."environmentId" IS NULL) OR
				("environmentVariable"."scope" = 'project' AND "environmentVariable"."projectId" IS NOT NULL AND "environmentVariable"."environmentId" IS NULL) OR
				("environmentVariable"."scope" = 'environment' AND "environmentVariable"."projectId" IS NOT NULL AND "environmentVariable"."environmentId" IS NOT NULL)
			));