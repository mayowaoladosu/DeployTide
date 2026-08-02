import { relations, sql } from "drizzle-orm";
import {
	boolean,
	check,
	foreignKey,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { environments } from "./environment";
import { operations } from "./operation";
import { projects } from "./project";
import { encryptedText } from "./utils";

export const variableScope = pgEnum("variableScope", [
	"workspace",
	"project",
	"environment",
]);

export const variableExposure = pgEnum("variableExposure", [
	"runtime",
	"build",
	"both",
]);

export const environmentVariables = pgTable(
	"environmentVariable",
	{
		environmentVariableId: text("environmentVariableId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("projectId").references(() => projects.projectId, {
			onDelete: "cascade",
		}),
		environmentId: text("environmentId").references(
			() => environments.environmentId,
			{ onDelete: "cascade" },
		),
		scope: variableScope("scope").notNull(),
		key: text("key").notNull(),
		exposure: variableExposure("exposure").notNull().default("runtime"),
		sensitive: boolean("sensitive").notNull().default(true),
		currentVersion: integer("currentVersion").notNull().default(1),
		createdBy: text("createdBy"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deletedAt: timestamp("deletedAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("environment_variable_id_organization_unique").on(
			table.environmentVariableId,
			table.organizationId,
		),
		uniqueIndex("environment_variable_workspace_key_unique")
			.on(table.organizationId, table.key)
			.where(sql`${table.scope} = 'workspace' AND ${table.deletedAt} IS NULL`),
		uniqueIndex("environment_variable_project_key_unique")
			.on(table.organizationId, table.projectId, table.key)
			.where(sql`${table.scope} = 'project' AND ${table.deletedAt} IS NULL`),
		uniqueIndex("environment_variable_environment_key_unique")
			.on(table.organizationId, table.environmentId, table.key)
			.where(sql`${table.scope} = 'environment' AND ${table.deletedAt} IS NULL`),
		check(
			"environment_variable_scope_target_check",
			sql`(
				(${table.scope} = 'workspace' AND ${table.projectId} IS NULL AND ${table.environmentId} IS NULL) OR
				(${table.scope} = 'project' AND ${table.projectId} IS NOT NULL AND ${table.environmentId} IS NULL) OR
				(${table.scope} = 'environment' AND ${table.projectId} IS NOT NULL AND ${table.environmentId} IS NOT NULL)
			)`,
		),
		index("environment_variable_scope_idx").on(
			table.organizationId,
			table.scope,
		),
		index("environment_variable_project_idx").on(table.projectId),
		index("environment_variable_environment_idx").on(table.environmentId),
		foreignKey({
			name: "environment_variable_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [projects.projectId, projects.organizationId],
		}).onDelete("cascade"),
		foreignKey({
			name: "environment_variable_environment_project_organization_fk",
			columns: [table.environmentId, table.projectId, table.organizationId],
			foreignColumns: [
				environments.environmentId,
				environments.projectId,
				environments.organizationId,
			],
		}).onDelete("cascade"),
	],
);

export const secretVersions = pgTable(
	"secretVersion",
	{
		secretVersionId: text("secretVersionId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		environmentVariableId: text("environmentVariableId")
			.notNull()
			.references(() => environmentVariables.environmentVariableId, {
				onDelete: "cascade",
			}),
		version: integer("version").notNull(),
		value: encryptedText("value").notNull(),
		valueDigest: text("valueDigest").notNull(),
		operationId: text("operationId").references(() => operations.operationId, {
			onDelete: "set null",
		}),
		createdBy: text("createdBy"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("secret_version_id_variable_unique").on(
			table.secretVersionId,
			table.environmentVariableId,
		),
		uniqueIndex("secret_version_number_unique").on(
			table.environmentVariableId,
			table.version,
		),
		index("secret_version_variable_idx").on(table.environmentVariableId),
	],
);

export const environmentVariableRelations = relations(
	environmentVariables,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [environmentVariables.organizationId],
			references: [organization.id],
		}),
		project: one(projects, {
			fields: [environmentVariables.projectId],
			references: [projects.projectId],
		}),
		environment: one(environments, {
			fields: [environmentVariables.environmentId],
			references: [environments.environmentId],
		}),
		versions: many(secretVersions),
	}),
);

export const secretVersionRelations = relations(secretVersions, ({ one }) => ({
	variable: one(environmentVariables, {
		fields: [secretVersions.environmentVariableId],
		references: [environmentVariables.environmentVariableId],
	}),
	operation: one(operations, {
		fields: [secretVersions.operationId],
		references: [operations.operationId],
	}),
}));
