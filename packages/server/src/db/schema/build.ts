import { relations } from "drizzle-orm";
import {
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { deployments } from "./deployment";
import { operations } from "./operation";
import { projects } from "./project";

export const buildStatus = pgEnum("buildStatus", [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
]);

export const builds = pgTable(
	"build",
	{
		buildId: text("buildId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("projectId")
			.notNull()
			.references(() => projects.projectId, { onDelete: "cascade" }),
		deploymentId: text("deploymentId")
			.notNull()
			.references(() => deployments.deploymentId, { onDelete: "cascade" }),
		operationId: text("operationId").references(
			() => operations.operationId,
			{ onDelete: "set null" },
		),
		status: buildStatus("status").notNull().default("queued"),
		attempt: integer("attempt").notNull().default(1),
		workerRef: text("workerRef"),
		preset: text("preset"),
		buildPlan: jsonb("buildPlan").$type<Record<string, unknown>>().notNull(),
		sourceSnapshot: jsonb("sourceSnapshot")
			.$type<Record<string, unknown>>()
			.notNull(),
		cacheKey: text("cacheKey"),
		logStreamId: text("logStreamId"),
		errorCode: text("errorCode"),
		errorMessage: text("errorMessage"),
		queuedAt: timestamp("queuedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		startedAt: timestamp("startedAt", { withTimezone: true }),
		finishedAt: timestamp("finishedAt", { withTimezone: true }),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("build_deployment_attempt_unique").on(
			table.deploymentId,
			table.attempt,
		),
		uniqueIndex("build_id_organization_project_deployment_unique").on(
			table.buildId,
			table.organizationId,
			table.projectId,
			table.deploymentId,
		),
		uniqueIndex("build_id_organization_project_unique").on(
			table.buildId,
			table.organizationId,
			table.projectId,
		),
		index("build_org_status_idx").on(table.organizationId, table.status),
		index("build_project_created_idx").on(table.projectId, table.createdAt),
		foreignKey({
			name: "build_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [projects.projectId, projects.organizationId],
		}).onDelete("cascade"),
		foreignKey({
			name: "build_deployment_ownership_fk",
			columns: [
				table.deploymentId,
				table.organizationId,
				table.projectId,
			],
			foreignColumns: [
				deployments.deploymentId,
				deployments.organizationId,
				deployments.projectId,
			],
		}).onDelete("cascade"),
	],
);

export const buildRelations = relations(builds, ({ one }) => ({
	organization: one(organization, {
		fields: [builds.organizationId],
		references: [organization.id],
	}),
	project: one(projects, {
		fields: [builds.projectId],
		references: [projects.projectId],
	}),
	deployment: one(deployments, {
		fields: [builds.deploymentId],
		references: [deployments.deploymentId],
	}),
	operation: one(operations, {
		fields: [builds.operationId],
		references: [operations.operationId],
	}),
}));
