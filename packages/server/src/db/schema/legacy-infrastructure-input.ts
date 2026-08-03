import {
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { legacyInfrastructureDisposition } from "./infrastructure-shared";
import { runtimeClusters } from "./runtime-cluster";
import { runtimeTargets } from "./runtime-target";
import { server } from "./server";

export const legacyInfrastructureInputs = pgTable(
	"legacyInfrastructureInput",
	{
		legacyInfrastructureInputId: text("legacyInfrastructureInputId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		serverId: text("serverId")
			.notNull()
			.references(() => server.serverId, { onDelete: "restrict" }),
		disposition: legacyInfrastructureDisposition("disposition")
			.notNull()
			.default("ambiguous"),
		reviewNote: text("reviewNote"),
		exportPayload: jsonb("exportPayload").$type<Record<string, unknown>>(),
		importedRuntimeClusterId: text("importedRuntimeClusterId").references(
			() => runtimeClusters.runtimeClusterId,
			{ onDelete: "restrict" },
		),
		importedRuntimeTargetId: text("importedRuntimeTargetId").references(
			() => runtimeTargets.runtimeTargetId,
			{ onDelete: "restrict" },
		),
		reviewedBy: text("reviewedBy"),
		reviewedAt: timestamp("reviewedAt", { withTimezone: true }),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("legacy_infrastructure_server_unique").on(table.serverId),
		index("legacy_infrastructure_disposition_idx").on(table.disposition),
	],
);
