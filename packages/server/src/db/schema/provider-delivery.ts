import { relations } from "drizzle-orm";
import {
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
import { projects } from "./project";

export const deliveryProvider = pgEnum("deliveryProvider", [
	"github",
	"gitlab",
	"bitbucket",
	"gitea",
	"api",
]);

export const providerDeliveryStatus = pgEnum("providerDeliveryStatus", [
	"received",
	"processing",
	"processed",
	"ignored",
	"failed",
]);

export const providerDeliveries = pgTable(
	"providerDelivery",
	{
		providerDeliveryId: text("providerDeliveryId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("projectId").references(() => projects.projectId, {
			onDelete: "set null",
		}),
		provider: deliveryProvider("provider").notNull(),
		externalDeliveryId: text("externalDeliveryId").notNull(),
		eventType: text("eventType").notNull(),
		payloadHash: text("payloadHash").notNull(),
		status: providerDeliveryStatus("status")
			.notNull()
			.default("received"),
		receivedAt: timestamp("receivedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		processedAt: timestamp("processedAt", { withTimezone: true }),
		errorCode: text("errorCode"),
		errorMessage: text("errorMessage"),
	},
	(table) => [
		uniqueIndex("provider_delivery_external_unique").on(
			table.organizationId,
			table.provider,
			table.externalDeliveryId,
		),
		uniqueIndex("provider_delivery_id_organization_project_unique").on(
			table.providerDeliveryId,
			table.organizationId,
			table.projectId,
		),
		index("provider_delivery_status_received_idx").on(
			table.status,
			table.receivedAt,
		),
		index("provider_delivery_project_idx").on(table.projectId),
		foreignKey({
			name: "provider_delivery_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [projects.projectId, projects.organizationId],
		}),
	],
);

export const providerDeliveryRelations = relations(
	providerDeliveries,
	({ one }) => ({
		organization: one(organization, {
			fields: [providerDeliveries.organizationId],
			references: [organization.id],
		}),
		project: one(projects, {
			fields: [providerDeliveries.projectId],
			references: [projects.projectId],
		}),
	}),
);
