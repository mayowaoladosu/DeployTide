import { relations } from "drizzle-orm";
import {
	bigint,
	foreignKey,
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { environments } from "./environment";
import { projects } from "./project";
import { releases } from "./release";

export const aliasKind = pgEnum("aliasKind", [
	"production",
	"branch",
	"custom",
	"immutable",
]);

export const aliasStatus = pgEnum("aliasStatus", [
	"pending",
	"ready",
	"error",
	"disabled",
]);

export const aliases = pgTable(
	"alias",
	{
		aliasId: text("aliasId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("projectId")
			.notNull()
			.references(() => projects.projectId, { onDelete: "cascade" }),
		environmentId: text("environmentId")
			.notNull()
			.references(() => environments.environmentId, { onDelete: "cascade" }),
		releaseId: text("releaseId").references(() => releases.releaseId, {
			onDelete: "restrict",
		}),
		kind: aliasKind("kind").notNull(),
		status: aliasStatus("status").notNull().default("pending"),
		hostname: text("hostname").notNull(),
		branch: text("branch"),
		version: bigint("version", { mode: "number" }).notNull().default(1),
		lastError: text("lastError"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("alias_hostname_unique").on(table.hostname),
		index("alias_project_kind_idx").on(table.projectId, table.kind),
		index("alias_release_idx").on(table.releaseId),
		foreignKey({
			name: "alias_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [projects.projectId, projects.organizationId],
		}).onDelete("cascade"),
		foreignKey({
			name: "alias_environment_project_organization_fk",
			columns: [table.environmentId, table.projectId, table.organizationId],
			foreignColumns: [
				environments.environmentId,
				environments.projectId,
				environments.organizationId,
			],
		}).onDelete("cascade"),
		foreignKey({
			name: "alias_release_ownership_fk",
			columns: [
				table.releaseId,
				table.organizationId,
				table.projectId,
				table.environmentId,
			],
			foreignColumns: [
				releases.releaseId,
				releases.organizationId,
				releases.projectId,
				releases.environmentId,
			],
		}).onDelete("restrict"),
	],
);

export const aliasHistory = pgTable(
	"aliasHistory",
	{
		aliasHistoryId: text("aliasHistoryId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		aliasId: text("aliasId")
			.notNull()
			.references(() => aliases.aliasId, { onDelete: "cascade" }),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		previousReleaseId: text("previousReleaseId").references(
			() => releases.releaseId,
			{ onDelete: "set null" },
		),
		nextReleaseId: text("nextReleaseId")
			.notNull()
			.references(() => releases.releaseId, { onDelete: "restrict" }),
		previousVersion: bigint("previousVersion", { mode: "number" }).notNull(),
		nextVersion: bigint("nextVersion", { mode: "number" }).notNull(),
		actorId: text("actorId"),
		reason: text("reason").notNull(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("alias_history_alias_created_idx").on(
			table.aliasId,
			table.createdAt,
		),
		foreignKey({
			name: "alias_history_previous_release_ownership_fk",
			columns: [table.previousReleaseId, table.organizationId],
			foreignColumns: [releases.releaseId, releases.organizationId],
		}),
		foreignKey({
			name: "alias_history_next_release_ownership_fk",
			columns: [table.nextReleaseId, table.organizationId],
			foreignColumns: [releases.releaseId, releases.organizationId],
		}).onDelete("restrict"),
	],
);

export const aliasRelations = relations(aliases, ({ one, many }) => ({
	organization: one(organization, {
		fields: [aliases.organizationId],
		references: [organization.id],
	}),
	project: one(projects, {
		fields: [aliases.projectId],
		references: [projects.projectId],
	}),
	environment: one(environments, {
		fields: [aliases.environmentId],
		references: [environments.environmentId],
	}),
	release: one(releases, {
		fields: [aliases.releaseId],
		references: [releases.releaseId],
	}),
	history: many(aliasHistory),
}));

export const aliasHistoryRelations = relations(aliasHistory, ({ one }) => ({
	alias: one(aliases, {
		fields: [aliasHistory.aliasId],
		references: [aliases.aliasId],
	}),
	previousRelease: one(releases, {
		fields: [aliasHistory.previousReleaseId],
		references: [releases.releaseId],
		relationName: "aliasHistoryPreviousRelease",
	}),
	nextRelease: one(releases, {
		fields: [aliasHistory.nextReleaseId],
		references: [releases.releaseId],
		relationName: "aliasHistoryNextRelease",
	}),
}));
