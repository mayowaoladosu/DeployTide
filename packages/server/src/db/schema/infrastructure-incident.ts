import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { buildPools } from "./build-pool";
import { infrastructureProviders } from "./infrastructure-provider";
import {
	infrastructureIncidentSeverity,
	infrastructureIncidentStatus,
} from "./infrastructure-shared";
import { regions } from "./region";
import { runtimeClusters } from "./runtime-cluster";

export const infrastructureIncidents = pgTable(
	"infrastructureIncident",
	{
		infrastructureIncidentId: text("infrastructureIncidentId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		infrastructureProviderId: text("infrastructureProviderId").references(
			() => infrastructureProviders.infrastructureProviderId,
			{ onDelete: "restrict" },
		),
		regionId: text("regionId").references(() => regions.regionId, {
			onDelete: "restrict",
		}),
		buildPoolId: text("buildPoolId").references(() => buildPools.buildPoolId, {
			onDelete: "restrict",
		}),
		runtimeClusterId: text("runtimeClusterId").references(
			() => runtimeClusters.runtimeClusterId,
			{ onDelete: "restrict" },
		),
		severity: infrastructureIncidentSeverity("severity").notNull(),
		status: infrastructureIncidentStatus("status").notNull().default("open"),
		title: text("title").notNull(),
		summary: text("summary").notNull(),
		redactedDetails: jsonb("redactedDetails").$type<Record<string, unknown>>(),
		openedBy: text("openedBy").notNull(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		resolvedAt: timestamp("resolvedAt", { withTimezone: true }),
	},
	(table) => [
		index("infrastructure_incident_status_idx").on(
			table.status,
			table.severity,
			table.createdAt,
		),
		index("infrastructure_incident_cluster_idx").on(
			table.runtimeClusterId,
			table.status,
		),
	],
);
