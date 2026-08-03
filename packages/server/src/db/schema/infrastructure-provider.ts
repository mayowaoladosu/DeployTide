import { sql } from "drizzle-orm";
import {
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import {
	infrastructureHealth,
	infrastructureStatus,
} from "./infrastructure-shared";

export type InfrastructureCapability =
	| "build.rootless"
	| "runtime.container"
	| "registry.oci"
	| "edge.http"
	| "telemetry.metrics"
	| "telemetry.logs"
	| (string & {});

export const infrastructureProviders = pgTable(
	"infrastructureProvider",
	{
		infrastructureProviderId: text("infrastructureProviderId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name").notNull(),
		adapterType: text("adapterType").notNull(),
		endpointReference: text("endpointReference").notNull(),
		secretReference: text("secretReference"),
		enabledRegionCodes: text("enabledRegionCodes")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		capabilities: jsonb("capabilities")
			.$type<InfrastructureCapability[]>()
			.notNull()
			.default([]),
		health: infrastructureHealth("health").notNull().default("unknown"),
		status: infrastructureStatus("status").notNull().default("provisioning"),
		version: text("version").notNull(),
		lastHealthAt: timestamp("lastHealthAt", { withTimezone: true }),
		healthDetails: jsonb("healthDetails").$type<Record<string, unknown>>(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deletedAt: timestamp("deletedAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("infrastructure_provider_name_unique").on(table.name),
		index("infrastructure_provider_status_idx").on(table.status, table.health),
		index("infrastructure_provider_adapter_idx").on(table.adapterType),
	],
);

export type InfrastructureProviderRecord =
	typeof infrastructureProviders.$inferSelect;
