import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { organization } from "./account";
import { infrastructureArchitecture } from "./infrastructure-shared";
import { projects } from "./project";

export const projectPlacementPolicies = pgTable(
	"projectPlacementPolicy",
	{
		projectId: text("projectId")
			.primaryKey()
			.references(() => projects.projectId, { onDelete: "cascade" }),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		preferredRegionCode: text("preferredRegionCode"),
		requiredCapabilities: text("requiredCapabilities")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		architecture: infrastructureArchitecture("architecture"),
		dataAffinity: jsonb("dataAffinity")
			.$type<Record<string, string>>()
			.notNull()
			.default({}),
		costClass: text("costClass").notNull().default("balanced"),
		fairQueueWeight: integer("fairQueueWeight").notNull().default(100),
		pinToRegion: boolean("pinToRegion").notNull().default(false),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		foreignKey({
			name: "project_placement_policy_ownership_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [projects.projectId, projects.organizationId],
		}).onDelete("cascade"),
		index("project_placement_policy_region_idx").on(
			table.preferredRegionCode,
			table.architecture,
		),
		check(
			"project_placement_policy_weight_valid",
			sql`${table.fairQueueWeight} >= 1 AND ${table.fairQueueWeight} <= 10000`,
		),
		check(
			"project_placement_policy_cost_class_valid",
			sql`${table.costClass} IN ('economy', 'balanced', 'performance')`,
		),
		check(
			"project_placement_policy_pin_region_valid",
			sql`${table.pinToRegion} = false OR ${table.preferredRegionCode} IS NOT NULL`,
		),
	],
);
