import { relations } from "drizzle-orm";
import {
	bigint,
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

export const operationStatus = pgEnum("operationStatus", [
	"pending",
	"running",
	"succeeded",
	"failed",
	"cancelled",
]);

export const operationActorType = pgEnum("operationActorType", [
	"user",
	"system",
	"provider",
	"operator",
]);

export const operations = pgTable(
	"operation",
	{
		operationId: text("operationId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		idempotencyKey: text("idempotencyKey").notNull(),
		kind: text("kind").notNull(),
		status: operationStatus("status").notNull().default("pending"),
		actorType: operationActorType("actorType").notNull().default("system"),
		actorId: text("actorId"),
		resourceType: text("resourceType").notNull(),
		resourceId: text("resourceId"),
		input: jsonb("input").$type<Record<string, unknown>>(),
		result: jsonb("result").$type<Record<string, unknown>>(),
		errorCode: text("errorCode"),
		errorMessage: text("errorMessage"),
		leaseOwner: text("leaseOwner"),
		leaseExpiresAt: timestamp("leaseExpiresAt", { withTimezone: true }),
		fencingToken: bigint("fencingToken", { mode: "number" })
			.notNull()
			.default(0),
		attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completedAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("operation_org_idempotency_unique").on(
			table.organizationId,
			table.idempotencyKey,
		),
		index("operation_org_status_idx").on(table.organizationId, table.status),
		index("operation_lease_idx").on(table.status, table.leaseExpiresAt),
		index("operation_resource_idx").on(
			table.organizationId,
			table.resourceType,
			table.resourceId,
		),
	],
);

export const operationRelations = relations(operations, ({ one }) => ({
	organization: one(organization, {
		fields: [operations.organizationId],
		references: [organization.id],
	}),
}));
