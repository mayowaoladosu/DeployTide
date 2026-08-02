CREATE TYPE "public"."aliasKind" AS ENUM('production', 'branch', 'custom', 'immutable');--> statement-breakpoint
CREATE TYPE "public"."aliasStatus" AS ENUM('pending', 'ready', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."artifactStatus" AS ENUM('available', 'quarantined', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."artifactType" AS ENUM('oci', 'static');--> statement-breakpoint
CREATE TYPE "public"."buildStatus" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."deploymentTrigger" AS ENUM('git_push', 'git_pull_request', 'manual', 'cli', 'api', 'import', 'redeploy', 'rollback', 'schedule');--> statement-breakpoint
CREATE TYPE "public"."environmentKind" AS ENUM('production', 'preview', 'development', 'custom');--> statement-breakpoint
CREATE TYPE "public"."variableExposure" AS ENUM('runtime', 'build', 'both');--> statement-breakpoint
CREATE TYPE "public"."variableScope" AS ENUM('workspace', 'project', 'environment');--> statement-breakpoint
CREATE TYPE "public"."operationActorType" AS ENUM('user', 'system', 'provider', 'operator');--> statement-breakpoint
CREATE TYPE "public"."operationStatus" AS ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."outboxEventStatus" AS ENUM('pending', 'processing', 'published', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."projectSourceProvider" AS ENUM('github', 'gitlab', 'bitbucket', 'gitea', 'git', 'container', 'upload');--> statement-breakpoint
CREATE TYPE "public"."deliveryProvider" AS ENUM('github', 'gitlab', 'bitbucket', 'gitea', 'api');--> statement-breakpoint
CREATE TYPE "public"."providerDeliveryStatus" AS ENUM('received', 'processing', 'processed', 'ignored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."releaseStatus" AS ENUM('queued', 'deploying', 'checking', 'ready', 'failed', 'cancelled', 'retired');--> statement-breakpoint
ALTER TYPE "public"."deploymentStatus" ADD VALUE 'queued' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."deploymentStatus" ADD VALUE 'preparing' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."deploymentStatus" ADD VALUE 'building' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."deploymentStatus" ADD VALUE 'deploying' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."deploymentStatus" ADD VALUE 'checking' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."deploymentStatus" ADD VALUE 'ready' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."deploymentStatus" ADD VALUE 'failed' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."deploymentStatus" ADD VALUE 'cancelling' BEFORE 'running';--> statement-breakpoint
CREATE TABLE "aliasHistory" (
	"aliasHistoryId" text PRIMARY KEY NOT NULL,
	"aliasId" text NOT NULL,
	"organizationId" text NOT NULL,
	"previousReleaseId" text,
	"nextReleaseId" text NOT NULL,
	"previousVersion" bigint NOT NULL,
	"nextVersion" bigint NOT NULL,
	"actorId" text,
	"reason" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alias" (
	"aliasId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"projectId" text NOT NULL,
	"environmentId" text NOT NULL,
	"releaseId" text,
	"kind" "aliasKind" NOT NULL,
	"status" "aliasStatus" DEFAULT 'pending' NOT NULL,
	"hostname" text NOT NULL,
	"branch" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact" (
	"artifactId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"projectId" text NOT NULL,
	"buildId" text NOT NULL,
	"type" "artifactType" NOT NULL,
	"status" "artifactStatus" DEFAULT 'available' NOT NULL,
	"digest" text NOT NULL,
	"mediaType" text,
	"registryRef" text,
	"objectKey" text,
	"architecture" text,
	"operatingSystem" text,
	"sizeBytes" bigint,
	"sbom" jsonb,
	"provenance" jsonb,
	"pinned" boolean DEFAULT false NOT NULL,
	"retentionUntil" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "branchHead" (
	"branchHeadId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"projectId" text NOT NULL,
	"environmentId" text NOT NULL,
	"branch" text NOT NULL,
	"commitSha" text NOT NULL,
	"desiredSequence" bigint DEFAULT 1 NOT NULL,
	"providerDeliveryId" text,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "build" (
	"buildId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"projectId" text NOT NULL,
	"deploymentId" text NOT NULL,
	"operationId" text,
	"status" "buildStatus" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"workerRef" text,
	"preset" text,
	"buildPlan" jsonb NOT NULL,
	"sourceSnapshot" jsonb NOT NULL,
	"cacheKey" text,
	"logStreamId" text,
	"errorCode" text,
	"errorMessage" text,
	"queuedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"startedAt" timestamp with time zone,
	"finishedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environmentVariable" (
	"environmentVariableId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"projectId" text,
	"environmentId" text,
	"scope" "variableScope" NOT NULL,
	"key" text NOT NULL,
	"exposure" "variableExposure" DEFAULT 'runtime' NOT NULL,
	"sensitive" boolean DEFAULT true NOT NULL,
	"currentVersion" integer DEFAULT 1 NOT NULL,
	"createdBy" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deletedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "secretVersion" (
	"secretVersionId" text PRIMARY KEY NOT NULL,
	"environmentVariableId" text NOT NULL,
	"version" integer NOT NULL,
	"value" text NOT NULL,
	"valueDigest" text NOT NULL,
	"createdBy" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation" (
	"operationId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"idempotencyKey" text NOT NULL,
	"kind" text NOT NULL,
	"status" "operationStatus" DEFAULT 'pending' NOT NULL,
	"actorType" "operationActorType" DEFAULT 'system' NOT NULL,
	"actorId" text,
	"resourceType" text NOT NULL,
	"resourceId" text,
	"input" jsonb,
	"result" jsonb,
	"errorCode" text,
	"errorMessage" text,
	"leaseOwner" text,
	"leaseExpiresAt" timestamp with time zone,
	"fencingToken" bigint DEFAULT 0 NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outboxEvent" (
	"eventId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"operationId" text,
	"dedupeKey" text NOT NULL,
	"eventType" text NOT NULL,
	"aggregateType" text NOT NULL,
	"aggregateId" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outboxEventStatus" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lockedAt" timestamp with time zone,
	"lockedBy" text,
	"publishedAt" timestamp with time zone,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projectSource" (
	"projectSourceId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"projectId" text NOT NULL,
	"provider" "projectSourceProvider" NOT NULL,
	"connectionId" text,
	"repositoryOwner" text,
	"repositoryName" text,
	"repositoryId" text,
	"defaultBranch" text DEFAULT 'main' NOT NULL,
	"rootDirectory" text DEFAULT '' NOT NULL,
	"monorepoMetadata" jsonb,
	"autoDeployPolicy" jsonb,
	"detectorVersion" text,
	"detectorResult" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providerDelivery" (
	"providerDeliveryId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"projectId" text,
	"provider" "deliveryProvider" NOT NULL,
	"externalDeliveryId" text NOT NULL,
	"eventType" text NOT NULL,
	"payloadHash" text NOT NULL,
	"payload" jsonb,
	"status" "providerDeliveryStatus" DEFAULT 'received' NOT NULL,
	"receivedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"processedAt" timestamp with time zone,
	"errorCode" text,
	"errorMessage" text
);
--> statement-breakpoint
CREATE TABLE "release" (
	"releaseId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"projectId" text NOT NULL,
	"environmentId" text NOT NULL,
	"deploymentId" text NOT NULL,
	"artifactId" text NOT NULL,
	"operationId" text,
	"status" "releaseStatus" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"runtimeConfigVersion" text NOT NULL,
	"runtimePlacementId" text,
	"serviceIdentity" text NOT NULL,
	"healthResult" jsonb,
	"failureCode" text,
	"failureMessage" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deployingAt" timestamp with time zone,
	"readyAt" timestamp with time zone,
	"failedAt" timestamp with time zone,
	"retiredAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "projectId" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "environmentId" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "trigger" "deploymentTrigger";--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "sourceProvider" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "sourceRevision" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "sourceBranch" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "sourceAuthor" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "sourceMessage" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "desiredSequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "immutableUrl" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "sourceConfigSnapshot" jsonb;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "buildConfigSnapshot" jsonb;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "runtimeConfigSnapshot" jsonb;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "errorCode" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "deletedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "organizationId" text;--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "kind" "environmentKind" DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "branchPattern" text;--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "protectionPolicy" jsonb;--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "retentionDays" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "deletedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "primaryApplicationId" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "deletedAt" timestamp with time zone;--> statement-breakpoint
UPDATE "environment" AS e
SET "organizationId" = p."organizationId"
FROM "project" AS p
WHERE e."projectId" = p."projectId"
	AND e."organizationId" IS NULL;--> statement-breakpoint
WITH ranked_environments AS (
	SELECT
		e."environmentId",
		ROW_NUMBER() OVER (
			PARTITION BY e."projectId"
			ORDER BY e."isDefault" DESC, e."createdAt" ASC, e."environmentId" ASC
		) AS position
	FROM "environment" AS e
)
UPDATE "environment" AS e
SET "kind" = CASE
	WHEN e."isDefault" = true AND ranked.position = 1
		THEN 'production'::"environmentKind"
	ELSE 'custom'::"environmentKind"
END
FROM ranked_environments AS ranked
WHERE e."environmentId" = ranked."environmentId";--> statement-breakpoint
WITH primary_applications AS (
	SELECT
		e."projectId",
		a."applicationId",
		ROW_NUMBER() OVER (
			PARTITION BY e."projectId"
			ORDER BY e."isDefault" DESC, a."createdAt" ASC, a."applicationId" ASC
		) AS position
	FROM "application" AS a
	INNER JOIN "environment" AS e
		ON e."environmentId" = a."environmentId"
)
UPDATE "project" AS p
SET "primaryApplicationId" = candidate."applicationId"
FROM primary_applications AS candidate
WHERE p."projectId" = candidate."projectId"
	AND candidate.position = 1
	AND p."primaryApplicationId" IS NULL;--> statement-breakpoint
UPDATE "deployment" AS d
SET
	"organizationId" = p."organizationId",
	"projectId" = p."projectId",
	"environmentId" = e."environmentId",
	"trigger" = CASE
		WHEN d."scheduleId" IS NOT NULL THEN 'schedule'::"deploymentTrigger"
		ELSE 'manual'::"deploymentTrigger"
	END,
	"sourceProvider" = a."sourceType"::text,
	"sourceRevision" = substring(d."description" from '^Commit: ([0-9A-Fa-f]+)'),
	"sourceBranch" = CASE a."sourceType"::text
		WHEN 'github' THEN a."branch"
		WHEN 'gitlab' THEN a."gitlabBranch"
		WHEN 'bitbucket' THEN a."bitbucketBranch"
		WHEN 'gitea' THEN a."giteaBranch"
		WHEN 'git' THEN a."customGitBranch"
		ELSE NULL
	END,
	"sourceConfigSnapshot" = jsonb_strip_nulls(jsonb_build_object(
		'applicationId', a."applicationId",
		'sourceType', a."sourceType"::text,
		'repository', COALESCE(
			a."repository", a."gitlabRepository", a."bitbucketRepository", a."giteaRepository",
			CASE WHEN a."customGitUrl" ~ '^[A-Za-z][A-Za-z0-9+.-]*://([^/@]+@|.*[?#])' THEN NULL ELSE a."customGitUrl" END
		),
		'owner', COALESCE(a."owner", a."gitlabOwner", a."bitbucketOwner", a."giteaOwner")
	)),
	"buildConfigSnapshot" = jsonb_strip_nulls(jsonb_build_object(
		'buildType', a."buildType"::text,
		'buildPath', COALESCE(a."buildPath", a."gitlabBuildPath", a."bitbucketBuildPath", a."giteaBuildPath", a."customGitBuildPath"),
		'dockerfile', a."dockerfile",
		'publishDirectory', a."publishDirectory"
	)),
	"runtimeConfigSnapshot" = jsonb_build_object(
		'applicationId', a."applicationId",
		'replicas', a."replicas",
		'legacyEnv', true
	)
FROM "application" AS a
INNER JOIN "environment" AS e
	ON e."environmentId" = a."environmentId"
INNER JOIN "project" AS p
	ON p."projectId" = e."projectId"
WHERE d."applicationId" = a."applicationId";--> statement-breakpoint
UPDATE "deployment" AS d
SET
	"organizationId" = p."organizationId",
	"projectId" = p."projectId",
	"environmentId" = e."environmentId",
	"trigger" = 'git_pull_request'::"deploymentTrigger",
	"sourceProvider" = a."sourceType"::text,
	"sourceRevision" = substring(d."description" from '^Commit: ([0-9A-Fa-f]+)'),
	"sourceBranch" = preview."branch",
	"sourceConfigSnapshot" = jsonb_build_object(
		'applicationId', a."applicationId",
		'previewDeploymentId', preview."previewDeploymentId",
		'pullRequestId', preview."pullRequestId"
	),
	"buildConfigSnapshot" = jsonb_build_object(
		'buildType', a."buildType"::text,
		'preview', true
	),
	"runtimeConfigSnapshot" = jsonb_build_object(
		'applicationId', a."applicationId",
		'preview', true,
		'legacyEnv', true
	)
FROM "preview_deployments" AS preview
INNER JOIN "application" AS a
	ON a."applicationId" = preview."applicationId"
INNER JOIN "environment" AS e
	ON e."environmentId" = a."environmentId"
INNER JOIN "project" AS p
	ON p."projectId" = e."projectId"
WHERE d."previewDeploymentId" = preview."previewDeploymentId"
	AND d."projectId" IS NULL;--> statement-breakpoint
UPDATE "deployment" AS d
SET
	"organizationId" = p."organizationId",
	"projectId" = p."projectId",
	"environmentId" = e."environmentId",
	"trigger" = CASE
		WHEN d."scheduleId" IS NOT NULL THEN 'schedule'::"deploymentTrigger"
		ELSE 'manual'::"deploymentTrigger"
	END,
	"sourceProvider" = c."sourceType"::text,
	"sourceRevision" = substring(d."description" from '^Commit: ([0-9A-Fa-f]+)'),
	"sourceBranch" = CASE c."sourceType"::text
		WHEN 'github' THEN c."branch"
		WHEN 'gitlab' THEN c."gitlabBranch"
		WHEN 'bitbucket' THEN c."bitbucketBranch"
		WHEN 'gitea' THEN c."giteaBranch"
		WHEN 'git' THEN c."customGitBranch"
		ELSE NULL
	END,
	"sourceConfigSnapshot" = jsonb_strip_nulls(jsonb_build_object(
		'composeId', c."composeId",
		'sourceType', c."sourceType"::text,
		'repository', COALESCE(
			c."repository", c."gitlabRepository", c."bitbucketRepository", c."giteaRepository",
			CASE WHEN c."customGitUrl" ~ '^[A-Za-z][A-Za-z0-9+.-]*://([^/@]+@|.*[?#])' THEN NULL ELSE c."customGitUrl" END
		)
	)),
	"buildConfigSnapshot" = jsonb_build_object('composeId', c."composeId"),
	"runtimeConfigSnapshot" = jsonb_build_object('composeId', c."composeId", 'legacyEnv', true)
FROM "compose" AS c
INNER JOIN "environment" AS e
	ON e."environmentId" = c."environmentId"
INNER JOIN "project" AS p
	ON p."projectId" = e."projectId"
WHERE d."composeId" = c."composeId"
	AND d."projectId" IS NULL;--> statement-breakpoint
UPDATE "deployment" AS d
SET
	"organizationId" = s."organizationId",
	"trigger" = CASE
		WHEN d."scheduleId" IS NOT NULL THEN 'schedule'::"deploymentTrigger"
		ELSE 'manual'::"deploymentTrigger"
	END
FROM "server" AS s
WHERE d."serverId" = s."serverId"
	AND d."organizationId" IS NULL;--> statement-breakpoint
UPDATE "deployment" AS d
SET
	"organizationId" = schedule."organizationId",
	"trigger" = 'schedule'::"deploymentTrigger"
FROM "schedule" AS schedule
WHERE d."scheduleId" = schedule."scheduleId"
	AND d."organizationId" IS NULL;--> statement-breakpoint
ALTER TABLE "aliasHistory" ADD CONSTRAINT "aliasHistory_aliasId_alias_aliasId_fk" FOREIGN KEY ("aliasId") REFERENCES "public"."alias"("aliasId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliasHistory" ADD CONSTRAINT "aliasHistory_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliasHistory" ADD CONSTRAINT "aliasHistory_previousReleaseId_release_releaseId_fk" FOREIGN KEY ("previousReleaseId") REFERENCES "public"."release"("releaseId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliasHistory" ADD CONSTRAINT "aliasHistory_nextReleaseId_release_releaseId_fk" FOREIGN KEY ("nextReleaseId") REFERENCES "public"."release"("releaseId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alias" ADD CONSTRAINT "alias_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alias" ADD CONSTRAINT "alias_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alias" ADD CONSTRAINT "alias_environmentId_environment_environmentId_fk" FOREIGN KEY ("environmentId") REFERENCES "public"."environment"("environmentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alias" ADD CONSTRAINT "alias_releaseId_release_releaseId_fk" FOREIGN KEY ("releaseId") REFERENCES "public"."release"("releaseId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_buildId_build_buildId_fk" FOREIGN KEY ("buildId") REFERENCES "public"."build"("buildId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branchHead" ADD CONSTRAINT "branchHead_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branchHead" ADD CONSTRAINT "branchHead_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branchHead" ADD CONSTRAINT "branchHead_environmentId_environment_environmentId_fk" FOREIGN KEY ("environmentId") REFERENCES "public"."environment"("environmentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build" ADD CONSTRAINT "build_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build" ADD CONSTRAINT "build_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build" ADD CONSTRAINT "build_deploymentId_deployment_deploymentId_fk" FOREIGN KEY ("deploymentId") REFERENCES "public"."deployment"("deploymentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build" ADD CONSTRAINT "build_operationId_operation_operationId_fk" FOREIGN KEY ("operationId") REFERENCES "public"."operation"("operationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environmentVariable" ADD CONSTRAINT "environmentVariable_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environmentVariable" ADD CONSTRAINT "environmentVariable_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environmentVariable" ADD CONSTRAINT "environmentVariable_environmentId_environment_environmentId_fk" FOREIGN KEY ("environmentId") REFERENCES "public"."environment"("environmentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secretVersion" ADD CONSTRAINT "secretVersion_environmentVariableId_environmentVariable_environmentVariableId_fk" FOREIGN KEY ("environmentVariableId") REFERENCES "public"."environmentVariable"("environmentVariableId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outboxEvent" ADD CONSTRAINT "outboxEvent_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outboxEvent" ADD CONSTRAINT "outboxEvent_operationId_operation_operationId_fk" FOREIGN KEY ("operationId") REFERENCES "public"."operation"("operationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projectSource" ADD CONSTRAINT "projectSource_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projectSource" ADD CONSTRAINT "projectSource_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providerDelivery" ADD CONSTRAINT "providerDelivery_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providerDelivery" ADD CONSTRAINT "providerDelivery_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_environmentId_environment_environmentId_fk" FOREIGN KEY ("environmentId") REFERENCES "public"."environment"("environmentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_deploymentId_deployment_deploymentId_fk" FOREIGN KEY ("deploymentId") REFERENCES "public"."deployment"("deploymentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_artifactId_artifact_artifactId_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifact"("artifactId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_operationId_operation_operationId_fk" FOREIGN KEY ("operationId") REFERENCES "public"."operation"("operationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alias_history_alias_created_idx" ON "aliasHistory" USING btree ("aliasId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "alias_hostname_unique" ON "alias" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "alias_project_kind_idx" ON "alias" USING btree ("projectId","kind");--> statement-breakpoint
CREATE INDEX "alias_release_idx" ON "alias" USING btree ("releaseId");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_org_digest_unique" ON "artifact" USING btree ("organizationId","digest");--> statement-breakpoint
CREATE INDEX "artifact_build_idx" ON "artifact" USING btree ("buildId");--> statement-breakpoint
CREATE INDEX "artifact_retention_idx" ON "artifact" USING btree ("status","retentionUntil");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_head_project_environment_branch_unique" ON "branchHead" USING btree ("projectId","environmentId","branch");--> statement-breakpoint
CREATE INDEX "branch_head_org_updated_idx" ON "branchHead" USING btree ("organizationId","updatedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "build_deployment_attempt_unique" ON "build" USING btree ("deploymentId","attempt");--> statement-breakpoint
CREATE INDEX "build_org_status_idx" ON "build" USING btree ("organizationId","status");--> statement-breakpoint
CREATE INDEX "build_project_created_idx" ON "build" USING btree ("projectId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_variable_scope_key_unique" ON "environmentVariable" USING btree ("organizationId","scope","projectId","environmentId","key");--> statement-breakpoint
CREATE INDEX "environment_variable_project_idx" ON "environmentVariable" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "environment_variable_environment_idx" ON "environmentVariable" USING btree ("environmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_version_number_unique" ON "secretVersion" USING btree ("environmentVariableId","version");--> statement-breakpoint
CREATE INDEX "secret_version_variable_idx" ON "secretVersion" USING btree ("environmentVariableId");--> statement-breakpoint
CREATE UNIQUE INDEX "operation_org_idempotency_unique" ON "operation" USING btree ("organizationId","idempotencyKey");--> statement-breakpoint
CREATE INDEX "operation_org_status_idx" ON "operation" USING btree ("organizationId","status");--> statement-breakpoint
CREATE INDEX "operation_lease_idx" ON "operation" USING btree ("status","leaseExpiresAt");--> statement-breakpoint
CREATE INDEX "operation_resource_idx" ON "operation" USING btree ("organizationId","resourceType","resourceId");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_event_org_dedupe_unique" ON "outboxEvent" USING btree ("organizationId","dedupeKey");--> statement-breakpoint
CREATE INDEX "outbox_event_dispatch_idx" ON "outboxEvent" USING btree ("status","availableAt");--> statement-breakpoint
CREATE INDEX "outbox_event_operation_idx" ON "outboxEvent" USING btree ("operationId");--> statement-breakpoint
CREATE UNIQUE INDEX "project_source_project_unique" ON "projectSource" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "project_source_repository_idx" ON "projectSource" USING btree ("organizationId","provider","repositoryId");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_delivery_external_unique" ON "providerDelivery" USING btree ("organizationId","provider","externalDeliveryId");--> statement-breakpoint
CREATE INDEX "provider_delivery_status_received_idx" ON "providerDelivery" USING btree ("status","receivedAt");--> statement-breakpoint
CREATE INDEX "provider_delivery_project_idx" ON "providerDelivery" USING btree ("projectId");--> statement-breakpoint
CREATE UNIQUE INDEX "release_deployment_attempt_unique" ON "release" USING btree ("deploymentId","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "release_service_identity_unique" ON "release" USING btree ("serviceIdentity");--> statement-breakpoint
CREATE INDEX "release_environment_status_idx" ON "release" USING btree ("environmentId","status");--> statement-breakpoint
CREATE INDEX "release_artifact_idx" ON "release" USING btree ("artifactId");--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_environmentId_environment_environmentId_fk" FOREIGN KEY ("environmentId") REFERENCES "public"."environment"("environmentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_primaryApplicationId_application_applicationId_fk" FOREIGN KEY ("primaryApplicationId") REFERENCES "public"."application"("applicationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployment_org_created_idx" ON "deployment" USING btree ("organizationId","createdAt");--> statement-breakpoint
CREATE INDEX "deployment_project_environment_idx" ON "deployment" USING btree ("projectId","environmentId","createdAt");--> statement-breakpoint
CREATE INDEX "deployment_status_idx" ON "deployment" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deployment_source_revision_idx" ON "deployment" USING btree ("projectId","sourceRevision");--> statement-breakpoint
CREATE INDEX "environment_org_kind_idx" ON "environment" USING btree ("organizationId","kind");--> statement-breakpoint
CREATE INDEX "environment_project_kind_idx" ON "environment" USING btree ("projectId","kind");