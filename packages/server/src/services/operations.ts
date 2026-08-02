import { db } from "@dokploy/server/db";
import { type operationActorType, operations } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import {
	assertStateTransition,
	type OperationState,
	operationTransitions,
} from "./state-machines/delivery";
import type { DatabaseTransaction } from "./tenancy";

export interface StartOperationInput {
	organizationId: string;
	idempotencyKey: string;
	kind: string;
	actorType?: (typeof operationActorType.enumValues)[number];
	actorId?: string;
	resourceType: string;
	resourceId?: string;
	input?: Record<string, unknown>;
}

const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, nested]) => nested !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

export const startOperation = async (
	input: StartOperationInput,
	transaction: DatabaseTransaction | typeof db = db,
) => {
	const [created] = await transaction
		.insert(operations)
		.values(input)
		.onConflictDoNothing({
			target: [operations.organizationId, operations.idempotencyKey],
		})
		.returning();

	if (created) return created;

	const existing = await transaction.query.operations.findFirst({
		where: and(
			eq(operations.organizationId, input.organizationId),
			eq(operations.idempotencyKey, input.idempotencyKey),
		),
	});
	if (!existing) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Operation could not be created or recovered",
		});
	}
	if (
		existing.kind !== input.kind ||
		existing.resourceType !== input.resourceType ||
		existing.resourceId !== (input.resourceId ?? null) ||
		canonicalJson(existing.input ?? null) !== canonicalJson(input.input ?? null)
	) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Idempotency key was already used for a different operation",
		});
	}
	return existing;
};

export type Operation = typeof operations.$inferSelect;

export interface TransitionOperationInput {
	organizationId: string;
	operationId: string;
	expectedStatus: OperationState;
	nextStatus: OperationState;
	result?: Record<string, unknown> | null;
	errorCode?: string | null;
	errorMessage?: string | null;
	leaseOwner?: string | null;
	leaseExpiresAt?: Date | null;
}

export const transitionOperation = async (
	input: TransitionOperationInput,
	transaction: DatabaseTransaction | typeof db = db,
) => {
	assertStateTransition(
		"operation",
		operationTransitions,
		input.expectedStatus,
		input.nextStatus,
	);
	const terminal = ["succeeded", "failed", "cancelled"].includes(
		input.nextStatus,
	);
	const [updated] = await transaction
		.update(operations)
		.set({
			status: input.nextStatus,
			result: input.result,
			errorCode: input.errorCode,
			errorMessage: input.errorMessage,
			leaseOwner: input.leaseOwner,
			leaseExpiresAt: input.leaseExpiresAt,
			attempts:
				input.nextStatus === "running"
					? sql`${operations.attempts} + 1`
					: undefined,
			updatedAt: new Date(),
			completedAt: terminal ? new Date() : null,
		})
		.where(
			and(
				eq(operations.operationId, input.operationId),
				eq(operations.organizationId, input.organizationId),
				eq(operations.status, input.expectedStatus),
			),
		)
		.returning();
	if (updated) return updated;

	const current = await transaction.query.operations.findFirst({
		where: and(
			eq(operations.operationId, input.operationId),
			eq(operations.organizationId, input.organizationId),
		),
	});
	if (!current) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Operation not found" });
	}
	throw new TRPCError({
		code: "CONFLICT",
		message: "Operation changed while its state transition was in progress",
	});
};
