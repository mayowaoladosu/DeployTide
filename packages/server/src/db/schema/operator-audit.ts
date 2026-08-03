import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";

export const operatorAuditLog = pgTable(
	"operatorAuditLog",
	{
		operatorAuditLogId: text("operatorAuditLogId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		actorUserId: text("actorUserId").notNull(),
		actorEmail: text("actorEmail").notNull(),
		action: text("action").notNull(),
		resourceType: text("resourceType").notNull(),
		resourceId: text("resourceId"),
		requestId: text("requestId"),
		metadata:
			jsonb("metadata").$type<Record<string, string | number | boolean>>(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("operator_audit_created_idx").on(table.createdAt),
		index("operator_audit_resource_idx").on(
			table.resourceType,
			table.resourceId,
		),
		index("operator_audit_actor_idx").on(table.actorUserId, table.createdAt),
	],
);
