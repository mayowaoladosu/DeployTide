import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { infrastructureProviders } from "./infrastructure-provider";
import {
	infrastructureDrainState,
	infrastructureHealth,
} from "./infrastructure-shared";
import { regions } from "./region";

export const runtimeClusters = pgTable(
	"runtimeCluster",
	{
		runtimeClusterId: text("runtimeClusterId")
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
		runtimeAdapter: text("runtimeAdapter").notNull(),
		endpointReference: text("endpointReference").notNull(),
		certificateReference: text("certificateReference").notNull(),
		controllerIdentity: text("controllerIdentity").notNull(),
		totalCpuMillis: integer("totalCpuMillis").notNull(),
		reservedCpuMillis: integer("reservedCpuMillis").notNull().default(0),
		totalMemoryMb: integer("totalMemoryMb").notNull(),
		reservedMemoryMb: integer("reservedMemoryMb").notNull().default(0),
		health: infrastructureHealth("health").notNull().default("unknown"),
		drainState: infrastructureDrainState("drainState")
			.notNull()
			.default("active"),
		controllerVersion: text("controllerVersion").notNull(),
		version: text("version").notNull(),
		lastHeartbeatAt: timestamp("lastHeartbeatAt", { withTimezone: true }),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deletedAt: timestamp("deletedAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("runtime_cluster_region_name_unique").on(
			table.regionId,
			table.name,
		),
		uniqueIndex("runtime_cluster_controller_identity_unique").on(
			table.controllerIdentity,
		),
		uniqueIndex("runtime_cluster_id_region_provider_unique").on(
			table.runtimeClusterId,
			table.regionId,
			table.infrastructureProviderId,
		),
		index("runtime_cluster_schedule_idx").on(
			table.regionId,
			table.health,
			table.drainState,
		),
		check(
			"runtime_cluster_capacity_valid",
			sql`${table.totalCpuMillis} > 0 AND ${table.reservedCpuMillis} >= 0 AND ${table.reservedCpuMillis} <= ${table.totalCpuMillis} AND ${table.totalMemoryMb} > 0 AND ${table.reservedMemoryMb} >= 0 AND ${table.reservedMemoryMb} <= ${table.totalMemoryMb}`,
		),
	],
);

export type RuntimeCluster = typeof runtimeClusters.$inferSelect;
