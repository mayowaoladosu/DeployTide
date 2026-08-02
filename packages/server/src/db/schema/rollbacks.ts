import { relations } from "drizzle-orm";
import {
	foreignKey,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { deployments } from "./deployment";
import { environments } from "./environment";
import { projects } from "./project";

export const rollbacks = pgTable("rollback", {
	rollbackId: text("rollbackId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	deploymentId: text("deploymentId")
		.notNull()
		.references(() => deployments.deploymentId, {
			onDelete: "cascade",
		}),
	version: serial(),
	image: text("image"),
	organizationId: text("organizationId").references(() => organization.id, {
		onDelete: "cascade",
	}),
	projectId: text("projectId").references(() => projects.projectId, {
		onDelete: "cascade",
	}),
	environmentId: text("environmentId").references(
		() => environments.environmentId,
		{ onDelete: "cascade" },
	),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	/** @deprecated Retained empty for downgrade compatibility; removed in Phase 10. */
	fullContext: jsonb("fullContext").$type<Record<string, never>>(),
	deletedAt: timestamp("deletedAt", { withTimezone: true }),
}, (table) => [
	uniqueIndex("rollback_id_organization_project_environment_unique").on(
		table.rollbackId,
		table.organizationId,
		table.projectId,
		table.environmentId,
	),
	foreignKey({
		name: "rollback_project_organization_fk",
		columns: [table.projectId, table.organizationId],
		foreignColumns: [projects.projectId, projects.organizationId],
	}).onDelete("cascade"),
	foreignKey({
		name: "rollback_environment_project_organization_fk",
		columns: [table.environmentId, table.projectId, table.organizationId],
		foreignColumns: [
			environments.environmentId,
			environments.projectId,
			environments.organizationId,
		],
	}).onDelete("cascade"),
	foreignKey({
		name: "rollback_deployment_ownership_fk",
		columns: [
			table.deploymentId,
			table.organizationId,
			table.projectId,
			table.environmentId,
		],
		foreignColumns: [
			deployments.deploymentId,
			deployments.organizationId,
			deployments.projectId,
			deployments.environmentId,
		],
	}).onDelete("cascade"),
]);

export type Rollback = typeof rollbacks.$inferSelect;

export const rollbacksRelations = relations(rollbacks, ({ one }) => ({
	organization: one(organization, {
		fields: [rollbacks.organizationId],
		references: [organization.id],
	}),
	project: one(projects, {
		fields: [rollbacks.projectId],
		references: [projects.projectId],
	}),
	environment: one(environments, {
		fields: [rollbacks.environmentId],
		references: [environments.environmentId],
	}),
	deployment: one(deployments, {
		fields: [rollbacks.deploymentId],
		references: [deployments.deploymentId],
	}),
}));

export const createRollbackSchema = createInsertSchema(rollbacks).extend({
	appName: z.string().min(1),
});

export const updateRollbackSchema = createRollbackSchema.extend({
	rollbackId: z.string().min(1),
});

export const apiFindOneRollback = z.object({
	rollbackId: z.string().min(1),
});
