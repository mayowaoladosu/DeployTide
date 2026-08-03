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
import { infrastructureStatus } from "./infrastructure-shared";

export const regions = pgTable(
	"region",
	{
		regionId: text("regionId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		infrastructureProviderId: text("infrastructureProviderId")
			.notNull()
			.references(() => infrastructureProviders.infrastructureProviderId, {
				onDelete: "restrict",
			}),
		code: text("code").notNull(),
		name: text("name").notNull(),
		providerRegionReference: text("providerRegionReference").notNull(),
		buildAvailable: boolean("buildAvailable").notNull().default(false),
		runtimeAvailable: boolean("runtimeAvailable").notNull().default(false),
		status: infrastructureStatus("status").notNull().default("provisioning"),
		residencyMetadata: jsonb("residencyMetadata")
			.$type<Record<string, string | boolean>>()
			.notNull()
			.default({}),
		routingWeight: integer("routingWeight").notNull().default(100),
		costWeight: integer("costWeight").notNull().default(100),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deletedAt: timestamp("deletedAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("region_code_unique").on(table.code),
		uniqueIndex("region_provider_reference_unique").on(
			table.infrastructureProviderId,
			table.providerRegionReference,
		),
		index("region_provider_status_idx").on(
			table.infrastructureProviderId,
			table.status,
		),
		check(
			"region_routing_weight_positive",
			sql`${table.routingWeight} > 0 AND ${table.costWeight} > 0`,
		),
	],
);

export type Region = typeof regions.$inferSelect;
