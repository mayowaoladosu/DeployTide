import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	check,
	foreignKey,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { buildPools } from "./build-pool";
import { capacityLeases } from "./capacity-lease";
import { operatorJobKind, operatorJobStatus } from "./infrastructure-shared";
import { operations } from "./operation";
import { runtimeClusters } from "./runtime-cluster";

export const operatorJobAttempts = pgTable(
	"operatorJobAttempt",
	{
		operatorJobAttemptId: text("operatorJobAttemptId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		operationId: text("operationId")
			.notNull()
			.references(() => operations.operationId, { onDelete: "restrict" }),
		capacityLeaseId: text("capacityLeaseId")
			.notNull()
			.references(() => capacityLeases.capacityLeaseId, {
				onDelete: "restrict",
			}),
		buildPoolId: text("buildPoolId").references(() => buildPools.buildPoolId, {
			onDelete: "restrict",
		}),
		runtimeClusterId: text("runtimeClusterId")
			.references(() => runtimeClusters.runtimeClusterId, {
				onDelete: "restrict",
			})
			.notNull(),
		kind: operatorJobKind("kind").notNull(),
		sequence: bigserial("sequence", { mode: "number" }).notNull(),
		fencingToken: bigint("fencingToken", { mode: "number" }).notNull(),
		request: jsonb("request").$type<Record<string, unknown>>().notNull(),
		signature: text("signature"),
		status: operatorJobStatus("status").notNull().default("queued"),
		acknowledgedAt: timestamp("acknowledgedAt", { withTimezone: true }),
		progress: jsonb("progress").$type<Record<string, unknown>>(),
		result: jsonb("result").$type<Record<string, unknown>>(),
		retryable: boolean("retryable").notNull().default(false),
		redactedDiagnostics: text("redactedDiagnostics"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completedAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("operator_job_sequence_unique").on(table.sequence),
		index("operator_job_cluster_status_idx").on(
			table.runtimeClusterId,
			table.status,
			table.sequence,
		),
		index("operator_job_pool_status_idx").on(table.buildPoolId, table.status),
		index("operator_job_operation_idx").on(table.operationId, table.status),
		foreignKey({
			name: "operator_job_lease_tuple_fk",
			columns: [
				table.capacityLeaseId,
				table.operationId,
				table.runtimeClusterId,
				table.fencingToken,
			],
			foreignColumns: [
				capacityLeases.capacityLeaseId,
				capacityLeases.operationId,
				capacityLeases.runtimeClusterId,
				capacityLeases.fencingToken,
			],
		}).onDelete("restrict"),
		check(
			"operator_job_target_valid",
			sql`${table.buildPoolId} IS NULL AND ${table.runtimeClusterId} IS NOT NULL`,
		),
		check(
			"operator_job_fencing_token_positive",
			sql`${table.fencingToken} > 0`,
		),
		check(
			"operator_job_release_environment_empty",
			sql`${table.kind} <> 'release_create' OR (jsonb_typeof(${table.request}) = 'object' AND ${table.request} ? 'environment' AND ${table.request}->'environment' = '{}'::jsonb)`,
		),
		check(
			"operator_job_payload_bounds",
			sql`octet_length(${table.request}::text) <= 1048576 AND (${table.progress} IS NULL OR octet_length(${table.progress}::text) <= 65536) AND (${table.result} IS NULL OR octet_length(${table.result}::text) <= 65536) AND (${table.redactedDiagnostics} IS NULL OR char_length(${table.redactedDiagnostics}) <= 8000)`,
		),
	],
);

export type OperatorJobAttempt = typeof operatorJobAttempts.$inferSelect;
