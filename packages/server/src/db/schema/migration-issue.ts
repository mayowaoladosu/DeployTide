import { relations } from "drizzle-orm";
import {
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";

export const canonicalMigrationIssues = pgTable(
	"canonicalMigrationIssue",
	{
		migrationIssueId: text("migrationIssueId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId").references(() => organization.id, {
			onDelete: "cascade",
		}),
		resourceType: text("resourceType").notNull(),
		resourceId: text("resourceId").notNull(),
		code: text("code").notNull(),
		details: jsonb("details").$type<Record<string, unknown>>(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		resolvedAt: timestamp("resolvedAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("canonical_migration_issue_resource_unique").on(
			table.resourceType,
			table.resourceId,
			table.code,
		),
		index("canonical_migration_issue_open_idx").on(
			table.resolvedAt,
			table.createdAt,
		),
	],
);

export const canonicalMigrationIssueRelations = relations(
	canonicalMigrationIssues,
	({ one }) => ({
		organization: one(organization, {
			fields: [canonicalMigrationIssues.organizationId],
			references: [organization.id],
		}),
	}),
);
