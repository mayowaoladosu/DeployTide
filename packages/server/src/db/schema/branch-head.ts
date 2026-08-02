import { relations } from "drizzle-orm";
import {
	bigint,
	foreignKey,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { environments } from "./environment";
import { projects } from "./project";
import { providerDeliveries } from "./provider-delivery";

export const branchHeads = pgTable(
	"branchHead",
	{
		branchHeadId: text("branchHeadId")
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
		branch: text("branch").notNull(),
		commitSha: text("commitSha").notNull(),
		desiredSequence: bigint("desiredSequence", { mode: "number" })
			.notNull()
			.default(1),
		providerDeliveryId: text("providerDeliveryId").references(
			() => providerDeliveries.providerDeliveryId,
			{ onDelete: "set null" },
		),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("branch_head_project_environment_branch_unique").on(
			table.projectId,
			table.environmentId,
			table.branch,
		),
		index("branch_head_org_updated_idx").on(
			table.organizationId,
			table.updatedAt,
		),
		foreignKey({
			name: "branch_head_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [projects.projectId, projects.organizationId],
		}).onDelete("cascade"),
		foreignKey({
			name: "branch_head_environment_project_organization_fk",
			columns: [table.environmentId, table.projectId, table.organizationId],
			foreignColumns: [
				environments.environmentId,
				environments.projectId,
				environments.organizationId,
			],
		}).onDelete("cascade"),
		foreignKey({
			name: "branch_head_provider_delivery_ownership_fk",
			columns: [
				table.providerDeliveryId,
				table.organizationId,
				table.projectId,
			],
			foreignColumns: [
				providerDeliveries.providerDeliveryId,
				providerDeliveries.organizationId,
				providerDeliveries.projectId,
			],
		}),
	],
);

export const branchHeadRelations = relations(branchHeads, ({ one }) => ({
	organization: one(organization, {
		fields: [branchHeads.organizationId],
		references: [organization.id],
	}),
	project: one(projects, {
		fields: [branchHeads.projectId],
		references: [projects.projectId],
	}),
	environment: one(environments, {
		fields: [branchHeads.environmentId],
		references: [environments.environmentId],
	}),
	providerDelivery: one(providerDeliveries, {
		fields: [branchHeads.providerDeliveryId],
		references: [providerDeliveries.providerDeliveryId],
	}),
}));
