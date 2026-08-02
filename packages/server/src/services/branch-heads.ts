import {
	branchHeads,
	environments,
	outboxEvents,
	projects,
	providerDeliveries,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, lt } from "drizzle-orm";
import { startOperation, transitionOperation } from "./operations";
import { withWorkspaceTransaction } from "./tenancy";

export interface AdvanceBranchHeadInput {
	organizationId: string;
	projectId: string;
	environmentId: string;
	branch: string;
	commitSha: string;
	desiredSequence: number;
	providerDeliveryId?: string;
	idempotencyKey: string;
}

/**
 * Advances a branch only when the incoming provider sequence is newer.
 * Callers may safely process deliveries concurrently or retry older events:
 * the greatest sequence always wins, independent of completion order.
 */
export const advanceBranchHead = async (input: AdvanceBranchHeadInput) => {
	if (!input.branch.trim() || !/^[0-9a-f]{7,64}$/i.test(input.commitSha)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Branch and commit revision are required",
		});
	}
	if (!Number.isSafeInteger(input.desiredSequence) || input.desiredSequence < 1) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Branch sequence must be a positive safe integer",
		});
	}

	return withWorkspaceTransaction(input.organizationId, async (transaction) => {
		const [project, environment] = await Promise.all([
			transaction.query.projects.findFirst({
				where: and(
					eq(projects.projectId, input.projectId),
					eq(projects.organizationId, input.organizationId),
				),
			}),
			transaction.query.environments.findFirst({
				where: and(
					eq(environments.environmentId, input.environmentId),
					eq(environments.projectId, input.projectId),
					eq(environments.organizationId, input.organizationId),
				),
			}),
		]);
		if (!project || !environment) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Project environment not found",
			});
		}

		if (input.providerDeliveryId) {
			const delivery = await transaction.query.providerDeliveries.findFirst({
				where: and(
					eq(
						providerDeliveries.providerDeliveryId,
						input.providerDeliveryId,
					),
					eq(providerDeliveries.organizationId, input.organizationId),
				),
			});
			if (!delivery || (delivery.projectId && delivery.projectId !== input.projectId)) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Provider delivery not found",
				});
			}
		}

		const operation = await startOperation(
			{
				organizationId: input.organizationId,
				idempotencyKey: input.idempotencyKey,
				kind: "branch-head.advance",
				actorType: "provider",
				resourceType: "branch",
				resourceId: `${input.projectId}:${input.environmentId}:${input.branch}`,
				input: {
					projectId: input.projectId,
					environmentId: input.environmentId,
					branch: input.branch,
					commitSha: input.commitSha,
					desiredSequence: input.desiredSequence,
					providerDeliveryId: input.providerDeliveryId,
				},
			},
			transaction,
		);
		if (operation.status === "succeeded") {
			const current = await transaction.query.branchHeads.findFirst({
				where: and(
					eq(branchHeads.projectId, input.projectId),
					eq(branchHeads.environmentId, input.environmentId),
					eq(branchHeads.branch, input.branch),
					eq(branchHeads.organizationId, input.organizationId),
				),
			});
			if (!current) throw new Error("Completed branch operation has no branch head");
			return { branchHead: current, advanced: false, operation };
		}
		if (operation.status !== "pending") {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Branch operation is already in progress",
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

		const [advanced] = await transaction
			.insert(branchHeads)
			.values({
				organizationId: input.organizationId,
				projectId: input.projectId,
				environmentId: input.environmentId,
				branch: input.branch,
				commitSha: input.commitSha,
				desiredSequence: input.desiredSequence,
				providerDeliveryId: input.providerDeliveryId,
			})
			.onConflictDoUpdate({
				target: [
					branchHeads.projectId,
					branchHeads.environmentId,
					branchHeads.branch,
				],
				set: {
					organizationId: input.organizationId,
					commitSha: input.commitSha,
					desiredSequence: input.desiredSequence,
					providerDeliveryId: input.providerDeliveryId,
					updatedAt: new Date(),
				},
				setWhere: lt(branchHeads.desiredSequence, input.desiredSequence),
			})
			.returning();

		const current =
			advanced ??
			(await transaction.query.branchHeads.findFirst({
				where: and(
					eq(branchHeads.projectId, input.projectId),
					eq(branchHeads.environmentId, input.environmentId),
					eq(branchHeads.branch, input.branch),
					eq(branchHeads.organizationId, input.organizationId),
				),
			}));
		if (!current) throw new Error("Failed to persist branch head");

		if (advanced) {
			await transaction
				.insert(outboxEvents)
				.values({
					organizationId: input.organizationId,
					operationId: operation.operationId,
					dedupeKey: `branch:${input.projectId}:${input.environmentId}:${input.branch}:${input.desiredSequence}`,
					eventType: "branch.head.advanced",
					aggregateType: "branchHead",
					aggregateId: current.branchHeadId,
					payload: {
						branchHeadId: current.branchHeadId,
						projectId: input.projectId,
						environmentId: input.environmentId,
						branch: input.branch,
						commitSha: input.commitSha,
						desiredSequence: input.desiredSequence,
					},
				})
				.onConflictDoNothing({
					target: [outboxEvents.organizationId, outboxEvents.dedupeKey],
				});
		}

		const completed = await transitionOperation(
			{
				organizationId: input.organizationId,
				operationId: operation.operationId,
				expectedStatus: "running",
				nextStatus: "succeeded",
				result: {
					branchHeadId: current.branchHeadId,
					advanced: Boolean(advanced),
					winningSequence: current.desiredSequence,
				},
			},
			transaction,
		);
		return { branchHead: current, advanced: Boolean(advanced), operation: completed };
	});
};
