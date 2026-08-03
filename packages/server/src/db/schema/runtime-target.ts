import { sql } from "drizzle-orm";
import {
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
import {
	infrastructureArchitecture,
	infrastructureDrainState,
	infrastructureHealth,
} from "./infrastructure-shared";
import { runtimeClusters } from "./runtime-cluster";

export const runtimeTargets = pgTable(
	"runtimeTarget",
	{
		runtimeTargetId: text("runtimeTargetId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		runtimeClusterId: text("runtimeClusterId")
			.notNull()
			.references(() => runtimeClusters.runtimeClusterId, {
				onDelete: "cascade",
			}),
		providerTargetReference: text("providerTargetReference").notNull(),
		architecture: infrastructureArchitecture("architecture").notNull(),
		totalCpuMillis: integer("totalCpuMillis").notNull(),
		reservedCpuMillis: integer("reservedCpuMillis").notNull().default(0),
		totalMemoryMb: integer("totalMemoryMb").notNull(),
		reservedMemoryMb: integer("reservedMemoryMb").notNull().default(0),
		health: infrastructureHealth("health").notNull().default("unknown"),
		drainState: infrastructureDrainState("drainState")
			.notNull()
			.default("active"),
		placementLabels: jsonb("placementLabels")
			.$type<Record<string, string>>()
			.notNull()
			.default({}),
		lastHeartbeatAt: timestamp("lastHeartbeatAt", { withTimezone: true }),
		version: text("version").notNull(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deletedAt: timestamp("deletedAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("runtime_target_provider_reference_unique").on(
			table.runtimeClusterId,
			table.providerTargetReference,
		),
		uniqueIndex("runtime_target_id_cluster_unique").on(
			table.runtimeTargetId,
			table.runtimeClusterId,
		),
		index("runtime_target_schedule_idx").on(
			table.runtimeClusterId,
			table.architecture,
			table.health,
			table.drainState,
		),
		check(
			"runtime_target_capacity_valid",
			sql`${table.totalCpuMillis} > 0 AND ${table.reservedCpuMillis} >= 0 AND ${table.reservedCpuMillis} <= ${table.totalCpuMillis} AND ${table.totalMemoryMb} > 0 AND ${table.reservedMemoryMb} >= 0 AND ${table.reservedMemoryMb} <= ${table.totalMemoryMb}`,
		),
	],
);

export type RuntimeTarget = typeof runtimeTargets.$inferSelect;
