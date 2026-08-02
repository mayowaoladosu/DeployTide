import { db } from "@dokploy/server/db";
import {
	aliases,
	aliasHistory,
	outboxEvents,
	releases,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { startOperation, transitionOperation } from "./operations";
import {
	type AliasState,
	aliasTransitions,
	assertStateTransition,
} from "./state-machines/delivery";
import { withWorkspaceTransaction } from "./tenancy";

export interface MoveAliasInput {
	organizationId: string;
	aliasId: string;
	expectedVersion: number;
	nextReleaseId: string;
	actorId?: string;
	reason: string;
	idempotencyKey: string;
}

export const moveAlias = async (input: MoveAliasInput) =>
	withWorkspaceTransaction(input.organizationId, async (transaction) => {
		const operation = await startOperation(
			{
				organizationId: input.organizationId,
				idempotencyKey: input.idempotencyKey,
				kind: "alias.move",
				actorType: input.actorId ? "user" : "system",
				actorId: input.actorId,
				resourceType: "alias",
				resourceId: input.aliasId,
				input: {
					aliasId: input.aliasId,
					expectedVersion: input.expectedVersion,
					nextReleaseId: input.nextReleaseId,
					reason: input.reason,
				},
			},
			transaction,
		);
		const current = await transaction.query.aliases.findFirst({
			where: and(
				eq(aliases.aliasId, input.aliasId),
				eq(aliases.organizationId, input.organizationId),
			),
		});
		if (!current) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Alias not found" });
		}
		if (operation.status === "succeeded") return current;
		if (operation.status !== "pending") {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Alias promotion is already in progress",
			});
		}
		if (current.version !== input.expectedVersion) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Alias changed while this promotion was in progress",
			});
		}
		await transitionOperation(
			{
				organizationId: input.organizationId,
				operationId: operation.operationId,
				expectedStatus: "pending",
				nextStatus: "running",
			},
			transaction,
		);

		const target = await transaction.query.releases.findFirst({
			where: and(
				eq(releases.releaseId, input.nextReleaseId),
				eq(releases.organizationId, input.organizationId),
				eq(releases.projectId, current.projectId),
			),
		});
		if (!target || target.status !== "ready") {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Alias targets must be ready releases in the same project",
			});
		}
		if (target.environmentId !== current.environmentId) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Release is not compatible with the alias environment",
			});
		}
		if (
			current.kind === "immutable" &&
			current.releaseId &&
			current.releaseId !== target.releaseId
		) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Immutable deployment aliases cannot be moved",
			});
		}
		if (current.releaseId === target.releaseId) {
			await transitionOperation(
				{
					organizationId: input.organizationId,
					operationId: operation.operationId,
					expectedStatus: "running",
					nextStatus: "succeeded",
					result: {
						aliasId: current.aliasId,
						releaseId: target.releaseId,
						version: current.version,
						unchanged: true,
					},
				},
				transaction,
			);
			return current;
		}

		const nextVersion = input.expectedVersion + 1;
		const [updated] = await transaction
			.update(aliases)
			.set({
				releaseId: target.releaseId,
				version: nextVersion,
				status: "pending",
				lastError: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(aliases.aliasId, current.aliasId),
					eq(aliases.organizationId, input.organizationId),
					eq(aliases.version, input.expectedVersion),
				),
			)
			.returning();
		if (!updated) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Alias changed while this promotion was in progress",
			});
		}

		await transaction.insert(aliasHistory).values({
			aliasId: current.aliasId,
			organizationId: input.organizationId,
			previousReleaseId: current.releaseId,
			nextReleaseId: target.releaseId,
			previousVersion: input.expectedVersion,
			nextVersion,
			actorId: input.actorId,
			reason: input.reason,
		});
		await transaction
			.insert(outboxEvents)
			.values({
				organizationId: input.organizationId,
				operationId: operation.operationId,
				dedupeKey: `alias:${current.aliasId}:v${nextVersion}`,
				eventType: "alias.route.requested",
				aggregateType: "alias",
				aggregateId: current.aliasId,
				payload: {
					aliasId: current.aliasId,
					hostname: current.hostname,
					releaseId: target.releaseId,
					version: nextVersion,
				},
			})
			.onConflictDoNothing({
				target: [outboxEvents.organizationId, outboxEvents.dedupeKey],
			});
		await transitionOperation(
			{
				organizationId: input.organizationId,
				operationId: operation.operationId,
				expectedStatus: "running",
				nextStatus: "succeeded",
				result: {
					aliasId: updated.aliasId,
					releaseId: target.releaseId,
					version: nextVersion,
				},
			},
			transaction,
		);
		return updated;
	});

export interface TransitionAliasStatusInput {
	organizationId: string;
	aliasId: string;
	expectedVersion: number;
	expectedStatus: AliasState;
	nextStatus: AliasState;
	lastError?: string | null;
}

export const transitionAliasStatus = async (
	input: TransitionAliasStatusInput,
) => {
	assertStateTransition(
		"alias",
		aliasTransitions,
		input.expectedStatus,
		input.nextStatus,
	);
	if (input.nextStatus === "pending" || input.nextStatus === "ready") {
		const current = await db.query.aliases.findFirst({
			where: and(
				eq(aliases.aliasId, input.aliasId),
				eq(aliases.organizationId, input.organizationId),
				eq(aliases.version, input.expectedVersion),
				eq(aliases.status, input.expectedStatus),
			),
		});
		if (!current?.releaseId) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Alias activation requires a release target",
			});
		}
		const target = await db.query.releases.findFirst({
			where: and(
				eq(releases.releaseId, current.releaseId),
				eq(releases.organizationId, input.organizationId),
				eq(releases.projectId, current.projectId),
				eq(releases.environmentId, current.environmentId),
				eq(releases.status, "ready"),
			),
		});
		if (!target) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Alias activation requires a ready release target",
			});
		}
	}
	const [updated] = await db
		.update(aliases)
		.set({
			status: input.nextStatus,
			lastError: input.nextStatus === "error" ? input.lastError : null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(aliases.aliasId, input.aliasId),
				eq(aliases.organizationId, input.organizationId),
				eq(aliases.version, input.expectedVersion),
				eq(aliases.status, input.expectedStatus),
			),
		)
		.returning();
	if (updated) return updated;
	throw new TRPCError({
		code: "CONFLICT",
		message: "Alias changed while route state was being reconciled",
	});
};
