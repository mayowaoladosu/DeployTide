import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { infrastructureProviders } from "./infrastructure-provider";
import {
	infrastructureArchitecture,
	infrastructureDrainState,
	infrastructureHealth,
} from "./infrastructure-shared";
import { regions } from "./region";

export const buildPools = pgTable(
	"buildPool",
	{
		buildPoolId: text("buildPoolId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		infrastructureProviderId: text("infrastructureProviderId")
			.notNull()
			.references(() => infrastructureProviders.infrastructureProviderId, {
				onDelete: "restrict",
			}),
		regionId: text("regionId")
			.notNull()
			.references(() => regions.regionId, { onDelete: "restrict" }),
		name: text("name").notNull(),
		adapterType: text("adapterType").notNull(),
		architecture: infrastructureArchitecture("architecture").notNull(),
		workerClass: text("workerClass").notNull(),
		rootless: boolean("rootless").notNull().default(true),
		minCapacity: integer("minCapacity").notNull().default(0),
		maxCapacity: integer("maxCapacity").notNull(),
		totalCapacity: integer("totalCapacity").notNull(),
		reservedCapacity: integer("reservedCapacity").notNull().default(0),
		cacheNamespace: text("cacheNamespace").notNull(),
		endpointReference: text("endpointReference"),
		health: infrastructureHealth("health").notNull().default("unknown"),
		drainState: infrastructureDrainState("drainState")
			.notNull()
			.default("active"),
		autoscalingPolicy: jsonb("autoscalingPolicy")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		version: text("version").notNull(),
		lastHealthAt: timestamp("lastHealthAt", { withTimezone: true }),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deletedAt: timestamp("deletedAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("build_pool_region_name_unique").on(table.regionId, table.name),
		index("build_pool_schedule_idx").on(
			table.regionId,
			table.architecture,
			table.health,
			table.drainState,
		),
		check(
			"build_pool_capacity_valid",
			sql`${table.minCapacity} >= 0 AND ${table.maxCapacity} > 0 AND ${table.totalCapacity} >= ${table.minCapacity} AND ${table.totalCapacity} <= ${table.maxCapacity} AND ${table.reservedCapacity} >= 0 AND ${table.reservedCapacity} <= ${table.totalCapacity}`,
		),
		check("build_pool_rootless_required", sql`${table.rootless} = true`),
	],
);

export type BuildPool = typeof buildPools.$inferSelect;
