import { db } from "@dokploy/server/db";
import { buildPools, capacityLeases } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { OperatorAuditInput } from "../operator-audit";
import { recordOperatorAudit } from "../operator-audit";
import type { DatabaseTransaction } from "../tenancy";

const blockingLeaseStates = ["active", "releasing", "reconciling"] as const;

const lockBuildPool = async (
	transaction: DatabaseTransaction,
	buildPoolId: string,
) => {
	await transaction.execute(sql`
		select "buildPoolId"
		from "buildPool"
		where "buildPoolId" = ${buildPoolId}
		for update
	`);
	const pool = await transaction.query.buildPools.findFirst({
		where: and(
			eq(buildPools.buildPoolId, buildPoolId),
			isNull(buildPools.deletedAt),
		),
		columns: {
			buildPoolId: true,
			drainState: true,
		},
	});
	if (!pool) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Build pool not found",
		});
	}
	return pool;
};

const countBlockingLeases = async (
	transaction: DatabaseTransaction,
	buildPoolId: string,
) => {
	const [result] = await transaction
		.select({ count: sql<number>`count(*)::int` })
		.from(capacityLeases)
		.where(
			and(
				eq(capacityLeases.buildPoolId, buildPoolId),
				inArray(capacityLeases.state, blockingLeaseStates),
			),
		);
	return result?.count ?? 0;
};

/** Stops only the selected pool from accepting new scheduler reservations. */
export const requestBuildPoolDrain = async (
	buildPoolId: string,
	audit?: OperatorAuditInput,
) =>
	db.transaction(async (transaction) => {
		const current = await lockBuildPool(transaction, buildPoolId);
		if (current.drainState !== "active") return current;

		const [draining] = await transaction
			.update(buildPools)
			.set({ drainState: "draining", updatedAt: new Date() })
			.where(
				and(
					eq(buildPools.buildPoolId, buildPoolId),
					eq(buildPools.drainState, "active"),
					isNull(buildPools.deletedAt),
				),
			)
			.returning({
				buildPoolId: buildPools.buildPoolId,
				drainState: buildPools.drainState,
			});
		if (!draining) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Build pool drain state changed",
			});
		}
		if (audit) {
			await recordOperatorAudit(
				{ ...audit, resourceId: buildPoolId },
				transaction,
			);
		}
		return draining;
	});

/**
 * Completes a drain only after every lease for this exact pool has left a
 * reservation-bearing state. The pool row lock also fences new reservations.
 */
export const reconcileBuildPoolDrain = async (
	buildPoolId: string,
	audit?: OperatorAuditInput,
) =>
	db.transaction(async (transaction) => {
		const current = await lockBuildPool(transaction, buildPoolId);
		if (current.drainState === "active") {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Build pool is not draining",
			});
		}
		if (current.drainState === "drained") {
			return {
				buildPoolId,
				drainState: "drained" as const,
				complete: true,
				activeLeaseCount: 0,
			};
		}

		const activeLeaseCount = await countBlockingLeases(
			transaction,
			buildPoolId,
		);
		if (activeLeaseCount > 0) {
			return {
				buildPoolId,
				drainState: "draining" as const,
				complete: false,
				activeLeaseCount,
			};
		}

		const [drained] = await transaction
			.update(buildPools)
			.set({ drainState: "drained", updatedAt: new Date() })
			.where(
				and(
					eq(buildPools.buildPoolId, buildPoolId),
					eq(buildPools.drainState, "draining"),
					isNull(buildPools.deletedAt),
				),
			)
			.returning({ buildPoolId: buildPools.buildPoolId });
		if (!drained) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Build pool drain state changed",
			});
		}
		if (audit) {
			await recordOperatorAudit(
				{
					...audit,
					resourceId: buildPoolId,
					metadata: {
						...audit.metadata,
						complete: true,
						activeLeases: 0,
					},
				},
				transaction,
			);
		}
		return {
			buildPoolId,
			drainState: "drained" as const,
			complete: true,
			activeLeaseCount: 0,
		};
	});

/**
 * Reopens scheduler admission without recreating workers or changing health
 * evidence. Existing freshness and health gates therefore remain in force.
 */
export const restoreBuildPool = async (
	buildPoolId: string,
	audit?: OperatorAuditInput,
) =>
	db.transaction(async (transaction) => {
		const current = await lockBuildPool(transaction, buildPoolId);
		if (current.drainState === "active") return current;

		const activeLeaseCount = await countBlockingLeases(
			transaction,
			buildPoolId,
		);
		if (activeLeaseCount > 0) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Build pool still has reservation-bearing leases",
			});
		}

		const [restored] = await transaction
			.update(buildPools)
			.set({ drainState: "active", updatedAt: new Date() })
			.where(
				and(
					eq(buildPools.buildPoolId, buildPoolId),
					inArray(buildPools.drainState, ["draining", "drained"]),
					isNull(buildPools.deletedAt),
				),
			)
			.returning({
				buildPoolId: buildPools.buildPoolId,
				drainState: buildPools.drainState,
			});
		if (!restored) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Build pool drain state changed",
			});
		}
		if (audit) {
			await recordOperatorAudit(
				{ ...audit, resourceId: buildPoolId },
				transaction,
			);
		}
		return restored;
	});
