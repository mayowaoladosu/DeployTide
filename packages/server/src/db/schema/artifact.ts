import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
	foreignKey,
	index,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { builds } from "./build";
import { projects } from "./project";

export const artifactType = pgEnum("artifactType", ["oci", "static"]);
export const artifactStatus = pgEnum("artifactStatus", [
	"available",
	"quarantined",
	"deleted",
]);

export const artifacts = pgTable(
	"artifact",
	{
		artifactId: text("artifactId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("projectId")
			.notNull()
			.references(() => projects.projectId, { onDelete: "cascade" }),
		buildId: text("buildId")
			.notNull()
			.references(() => builds.buildId, { onDelete: "restrict" }),
		type: artifactType("type").notNull(),
		status: artifactStatus("status").notNull().default("available"),
		digest: text("digest").notNull(),
		mediaType: text("mediaType"),
		registryRef: text("registryRef"),
		objectKey: text("objectKey"),
		architecture: text("architecture"),
		operatingSystem: text("operatingSystem"),
		sizeBytes: bigint("sizeBytes", { mode: "number" }),
		sbom: jsonb("sbom").$type<Record<string, unknown>>(),
		provenance: jsonb("provenance").$type<Record<string, unknown>>(),
		pinned: boolean("pinned").notNull().default(false),
		retentionUntil: timestamp("retentionUntil", { withTimezone: true }),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deletedAt: timestamp("deletedAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("artifact_org_digest_unique").on(
			table.organizationId,
			table.digest,
		),
		uniqueIndex("artifact_id_organization_project_build_unique").on(
			table.artifactId,
			table.organizationId,
			table.projectId,
			table.buildId,
		),
		uniqueIndex("artifact_id_organization_project_unique").on(
			table.artifactId,
			table.organizationId,
			table.projectId,
		),
		index("artifact_build_idx").on(table.buildId),
		index("artifact_retention_idx").on(table.status, table.retentionUntil),
		foreignKey({
			name: "artifact_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [projects.projectId, projects.organizationId],
		}).onDelete("cascade"),
		foreignKey({
			name: "artifact_build_ownership_fk",
			columns: [table.buildId, table.organizationId, table.projectId],
			foreignColumns: [builds.buildId, builds.organizationId, builds.projectId],
		}).onDelete("restrict"),
	],
);

export const artifactRelations = relations(artifacts, ({ one }) => ({
	organization: one(organization, {
		fields: [artifacts.organizationId],
		references: [organization.id],
	}),
	project: one(projects, {
		fields: [artifacts.projectId],
		references: [projects.projectId],
	}),
	build: one(builds, {
		fields: [artifacts.buildId],
		references: [builds.buildId],
	}),
}));
