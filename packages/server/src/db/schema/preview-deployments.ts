import { relations } from "drizzle-orm";
import {
	foreignKey,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { applications } from "./application";
import { deployments } from "./deployment";
import { domains } from "./domain";
import { environments } from "./environment";
import { projects } from "./project";
import { applicationStatus } from "./shared";
import { generateAppName } from "./utils";

export const previewDeployments = pgTable("preview_deployments", {
	previewDeploymentId: text("previewDeploymentId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	branch: text("branch").notNull(),
	pullRequestId: text("pullRequestId").notNull(),
	pullRequestNumber: text("pullRequestNumber").notNull(),
	pullRequestURL: text("pullRequestURL").notNull(),
	pullRequestTitle: text("pullRequestTitle").notNull(),
	pullRequestCommentId: text("pullRequestCommentId").notNull(),
	previewStatus: applicationStatus("previewStatus").notNull().default("idle"),
	appName: text("appName")
		.notNull()
		.$defaultFn(() => generateAppName("preview"))
		.unique(),
	applicationId: text("applicationId")
		.notNull()
		.references(() => applications.applicationId, {
			onDelete: "cascade",
		}),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	projectId: text("projectId")
		.notNull()
		.references(() => projects.projectId, { onDelete: "cascade" }),
	environmentId: text("environmentId")
		.notNull()
		.references(() => environments.environmentId, { onDelete: "cascade" }),
	domainId: text("domainId").references(() => domains.domainId, {
		onDelete: "cascade",
	}),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	expiresAt: text("expiresAt"),
	deletedAt: timestamp("deletedAt", { withTimezone: true }),
}, (table) => [
	uniqueIndex("preview_id_organization_project_environment_unique").on(
		table.previewDeploymentId,
		table.organizationId,
		table.projectId,
		table.environmentId,
	),
	foreignKey({
		name: "preview_project_organization_fk",
		columns: [table.projectId, table.organizationId],
		foreignColumns: [projects.projectId, projects.organizationId],
	}).onDelete("cascade"),
	foreignKey({
		name: "preview_environment_project_organization_fk",
		columns: [table.environmentId, table.projectId, table.organizationId],
		foreignColumns: [
			environments.environmentId,
			environments.projectId,
			environments.organizationId,
		],
	}).onDelete("cascade"),
	foreignKey({
		name: "preview_application_ownership_fk",
		columns: [
			table.applicationId,
			table.organizationId,
			table.projectId,
			table.environmentId,
		],
		foreignColumns: [
			applications.applicationId,
			applications.organizationId,
			applications.projectId,
			applications.environmentId,
		],
	}).onDelete("cascade"),
]);

export const previewDeploymentsRelations = relations(
	previewDeployments,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [previewDeployments.organizationId],
			references: [organization.id],
		}),
		project: one(projects, {
			fields: [previewDeployments.projectId],
			references: [projects.projectId],
		}),
		environment: one(environments, {
			fields: [previewDeployments.environmentId],
			references: [environments.environmentId],
		}),
		deployments: many(deployments),
		domain: one(domains, {
			fields: [previewDeployments.domainId],
			references: [domains.domainId],
		}),
		application: one(applications, {
			fields: [previewDeployments.applicationId],
			references: [applications.applicationId],
		}),
	}),
);

export const createSchema = createInsertSchema(previewDeployments, {
	applicationId: z.string(),
});

export const apiCreatePreviewDeployment = z.object({
	applicationId: z.string().min(1),
	domainId: z.string().optional(),
	branch: z.string().min(1),
	pullRequestId: z.string().min(1),
	pullRequestNumber: z.string().min(1),
	pullRequestURL: z.string().min(1),
	pullRequestTitle: z.string().min(1),
});
