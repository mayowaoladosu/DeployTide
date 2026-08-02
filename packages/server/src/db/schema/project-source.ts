import { relations } from "drizzle-orm";
import {
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
import { projects } from "./project";

export const projectSourceProvider = pgEnum("projectSourceProvider", [
	"github",
	"gitlab",
	"bitbucket",
	"gitea",
	"git",
	"container",
	"upload",
]);

export interface ProjectAutoDeployPolicy {
	enabled: boolean;
	productionBranch: string;
	previewBranches: boolean;
	ignoredBranches?: string[];
	watchPaths?: string[];
}

export const projectSources = pgTable(
	"projectSource",
	{
		projectSourceId: text("projectSourceId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("projectId")
			.notNull()
			.references(() => projects.projectId, { onDelete: "cascade" }),
		provider: projectSourceProvider("provider").notNull(),
		connectionId: text("connectionId"),
		repositoryOwner: text("repositoryOwner"),
		repositoryName: text("repositoryName"),
		repositoryId: text("repositoryId"),
		defaultBranch: text("defaultBranch").notNull().default("main"),
		rootDirectory: text("rootDirectory").notNull().default(""),
		monorepoMetadata: jsonb("monorepoMetadata").$type<Record<string, unknown>>(),
		autoDeployPolicy: jsonb("autoDeployPolicy").$type<ProjectAutoDeployPolicy>(),
		detectorVersion: text("detectorVersion"),
		detectorResult: jsonb("detectorResult").$type<Record<string, unknown>>(),
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("project_source_project_unique").on(table.projectId),
		index("project_source_repository_idx").on(
			table.organizationId,
			table.provider,
			table.repositoryId,
		),
		foreignKey({
			name: "project_source_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [projects.projectId, projects.organizationId],
		}).onDelete("cascade"),
	],
);

export const projectSourceRelations = relations(projectSources, ({ one }) => ({
	organization: one(organization, {
		fields: [projectSources.organizationId],
		references: [organization.id],
	}),
	project: one(projects, {
		fields: [projectSources.projectId],
		references: [projects.projectId],
	}),
}));
