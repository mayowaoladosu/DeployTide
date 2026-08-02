import { relations, sql } from "drizzle-orm";
import {
	boolean,
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
import { z } from "zod";
import { organization } from "./account";
import { applications } from "./application";
import { compose } from "./compose";
import { libsql } from "./libsql";
import { mariadb } from "./mariadb";
import { mongo } from "./mongo";
import { mysql } from "./mysql";
import { postgres } from "./postgres";
import { projects } from "./project";
import { redis } from "./redis";
import { encryptedText } from "./utils";

export const environmentKind = pgEnum("environmentKind", [
	"production",
	"preview",
	"development",
	"custom",
]);

export const environments = pgTable("environment", {
	environmentId: text("environmentId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	description: text("description"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	env: encryptedText("env").notNull().default(""),
	projectId: text("projectId")
		.notNull()
		.references(() => projects.projectId, { onDelete: "cascade" }),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	isDefault: boolean("isDefault").notNull().default(false),
	kind: environmentKind("kind").notNull().default("custom"),
	branchPattern: text("branchPattern"),
	protectionPolicy: jsonb("protectionPolicy").$type<Record<string, unknown>>(),
	retentionDays: integer("retentionDays").notNull().default(30),
	deletedAt: timestamp("deletedAt", { withTimezone: true }),
}, (table) => [
	index("environment_org_kind_idx").on(table.organizationId, table.kind),
	index("environment_project_kind_idx").on(table.projectId, table.kind),
	uniqueIndex("environment_one_production_per_project_unique")
		.on(table.projectId)
		.where(sql`${table.kind} = 'production' AND ${table.deletedAt} IS NULL`),
	uniqueIndex("environment_id_project_organization_unique").on(
		table.environmentId,
		table.projectId,
		table.organizationId,
	),
	foreignKey({
		name: "environment_project_organization_fk",
		columns: [table.projectId, table.organizationId],
		foreignColumns: [projects.projectId, projects.organizationId],
	}).onDelete("cascade"),
]);

export const environmentRelations = relations(
	environments,
	({ one, many }) => ({
		project: one(projects, {
			fields: [environments.projectId],
			references: [projects.projectId],
		}),
		organization: one(organization, {
			fields: [environments.organizationId],
			references: [organization.id],
		}),
		applications: many(applications),
		compose: many(compose),
		libsql: many(libsql),
		mariadb: many(mariadb),
		mongo: many(mongo),
		mysql: many(mysql),
		postgres: many(postgres),
		redis: many(redis),
	}),
);

export const apiCreateEnvironment = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	projectId: z.string().min(1),
});

export const apiFindOneEnvironment = z.object({
	environmentId: z.string().min(1),
});

export const apiRemoveEnvironment = z.object({
	environmentId: z.string().min(1),
});

export const apiUpdateEnvironment = z.object({
	environmentId: z.string().min(1),
	name: z.string().min(1).optional(),
	description: z.string().optional(),
	env: z.string().optional(),
});

export const apiDuplicateEnvironment = z.object({
	environmentId: z.string().min(1),
	name: z.string().min(1),
	description: z.string().optional(),
});
