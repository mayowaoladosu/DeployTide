import { sql } from "drizzle-orm";
import {
	bigserial,
	check,
	foreignKey,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { builds } from "./build";
import { buildPools } from "./build-pool";
import {
	capacityLeaseKind,
	capacityLeaseState,
	capacityReconciliationState,
} from "./infrastructure-shared";
import { operations } from "./operation";
import { releases } from "./release";
import { runtimeClusters } from "./runtime-cluster";
import { runtimeTargets } from "./runtime-target";

export const capacityLeases = pgTable(
	"capacityLease",
	{
		capacityLeaseId: text("capacityLeaseId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "restrict" }),
		operationId: text("operationId")
			.notNull()
			.references(() => operations.operationId, { onDelete: "restrict" }),
		buildId: text("buildId").references(() => builds.buildId, {
			onDelete: "restrict",
		}),
		releaseId: text("releaseId").references(() => releases.releaseId, {
			onDelete: "restrict",
		}),
		buildPoolId: text("buildPoolId").references(() => buildPools.buildPoolId, {
			onDelete: "restrict",
		}),
		runtimeClusterId: text("runtimeClusterId").references(
			() => runtimeClusters.runtimeClusterId,
			{ onDelete: "restrict" },
		),
		runtimeTargetId: text("runtimeTargetId").references(
			() => runtimeTargets.runtimeTargetId,
			{ onDelete: "restrict" },
		),
		kind: capacityLeaseKind("kind").notNull(),
		leaseScope: text("leaseScope").notNull().default("workspace"),
		reservedCapacity: integer("reservedCapacity").notNull().default(0),
		reservedCpuMillis: integer("reservedCpuMillis").notNull().default(0),
		reservedMemoryMb: integer("reservedMemoryMb").notNull().default(0),
		leaseOwner: text("leaseOwner").notNull(),
		expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
		fencingToken: bigserial("fencingToken", { mode: "number" }).notNull(),
		state: capacityLeaseState("state").notNull().default("active"),
		reconciliationState: capacityReconciliationState("reconciliationState")
			.notNull()
			.default("clean"),
		reconciliationAttempts: integer("reconciliationAttempts")
			.notNull()
			.default(0),
		reconciliationError: text("reconciliationError"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		releasedAt: timestamp("releasedAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("capacity_lease_fencing_token_unique").on(table.fencingToken),
		uniqueIndex("capacity_lease_job_tuple_unique").on(
			table.capacityLeaseId,
			table.operationId,
			table.runtimeClusterId,
			table.fencingToken,
		),
		index("capacity_lease_expiry_idx").on(table.state, table.expiresAt),
		index("capacity_lease_pool_idx").on(table.buildPoolId, table.state),
		index("capacity_lease_cluster_idx").on(table.runtimeClusterId, table.state),
		index("capacity_lease_workspace_idx").on(
			table.organizationId,
			table.kind,
			table.state,
		),
		foreignKey({
			name: "capacity_lease_release_ownership_fk",
			columns: [table.releaseId, table.organizationId],
			foreignColumns: [releases.releaseId, releases.organizationId],
		}).onDelete("restrict"),
		foreignKey({
			name: "capacity_lease_runtime_target_cluster_fk",
			columns: [table.runtimeTargetId, table.runtimeClusterId],
			foreignColumns: [
				runtimeTargets.runtimeTargetId,
				runtimeTargets.runtimeClusterId,
			],
		}).onDelete("restrict"),
		check(
			"capacity_lease_scope_valid",
			sql`${table.leaseScope} IN ('workspace', 'operator')`,
		),
		check(
			"capacity_lease_tuple_valid",
			sql`(${table.kind} = 'build' AND ${table.buildPoolId} IS NOT NULL AND ${table.runtimeClusterId} IS NULL AND ${table.runtimeTargetId} IS NULL AND ${table.releaseId} IS NULL AND ${table.reservedCapacity} > 0 AND ${table.reservedCpuMillis} = 0 AND ${table.reservedMemoryMb} = 0 AND ((${table.leaseScope} = 'workspace' AND ${table.buildId} IS NOT NULL) OR (${table.leaseScope} = 'operator' AND ${table.buildId} IS NULL))) OR (${table.kind} = 'runtime' AND ${table.buildPoolId} IS NULL AND ${table.runtimeClusterId} IS NOT NULL AND ${table.runtimeTargetId} IS NOT NULL AND ${table.buildId} IS NULL AND ${table.reservedCapacity} = 0 AND ${table.reservedCpuMillis} > 0 AND ${table.reservedMemoryMb} > 0 AND ((${table.leaseScope} = 'workspace' AND ${table.releaseId} IS NOT NULL) OR (${table.leaseScope} = 'operator' AND ${table.releaseId} IS NULL)))`,
		),
		check(
			"capacity_lease_reservation_nonnegative",
			sql`${table.reservedCapacity} >= 0 AND ${table.reservedCpuMillis} >= 0 AND ${table.reservedMemoryMb} >= 0`,
		),
		check(
			"capacity_lease_reconciliation_attempts_nonnegative",
			sql`${table.reconciliationAttempts} >= 0`,
		),
	],
);

export type CapacityLease = typeof capacityLeases.$inferSelect;
