import { relations } from "drizzle-orm";
import {
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
import { operations } from "./operation";

export const outboxEventStatus = pgEnum("outboxEventStatus", [
	"pending",
	"processing",
	"published",
	"failed",
	"dead",
]);

export const outboxEvents = pgTable(
	"outboxEvent",
	{
		eventId: text("eventId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		operationId: text("operationId").references(
			() => operations.operationId,
			{ onDelete: "set null" },
		),
		dedupeKey: text("dedupeKey").notNull(),
		eventType: text("eventType").notNull(),
		aggregateType: text("aggregateType").notNull(),
		aggregateId: text("aggregateId").notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		status: outboxEventStatus("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		availableAt: timestamp("availableAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lockedAt: timestamp("lockedAt", { withTimezone: true }),
		lockedBy: text("lockedBy"),
		publishedAt: timestamp("publishedAt", { withTimezone: true }),
		lastError: text("lastError"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("outbox_event_org_dedupe_unique").on(
			table.organizationId,
			table.dedupeKey,
		),
		index("outbox_event_dispatch_idx").on(table.status, table.availableAt),
		index("outbox_event_operation_idx").on(table.operationId),
	],
);

export const outboxEventRelations = relations(outboxEvents, ({ one }) => ({
	organization: one(organization, {
		fields: [outboxEvents.organizationId],
		references: [organization.id],
	}),
	operation: one(operations, {
		fields: [outboxEvents.operationId],
		references: [operations.operationId],
	}),
}));
