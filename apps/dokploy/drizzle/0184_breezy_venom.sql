ALTER TABLE "project" ADD COLUMN "slug" text DEFAULT substr(md5(random()::text), 1, 12) NOT NULL;--> statement-breakpoint
UPDATE "project"
SET "slug" = left(
	COALESCE(
		NULLIF(
			trim(BOTH '-' FROM regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')),
			''
		),
		'project'
	),
	50
) || '-' || substring(md5("projectId"), 1, 8);--> statement-breakpoint
CREATE UNIQUE INDEX "project_organization_slug_unique" ON "project" USING btree ("organizationId","slug");