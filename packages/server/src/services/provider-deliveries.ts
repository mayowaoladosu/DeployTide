import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	type deliveryProvider,
	projects,
	providerDeliveries,
	type providerDeliveryStatus,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

export interface ReceiveProviderDeliveryInput {
	organizationId: string;
	projectId?: string;
	provider: (typeof deliveryProvider.enumValues)[number];
	externalDeliveryId: string;
	eventType: string;
	rawBody: string | Buffer;
}

/**
 * Records only provider identity and an authenticated-body hash. Raw webhook
 * payloads are deliberately not persisted or treated as canonical product
 * state; handlers must derive validated commands before changing resources.
 */
export const receiveProviderDelivery = async (
	input: ReceiveProviderDeliveryInput,
) => {
	if (!input.externalDeliveryId.trim() || !input.eventType.trim()) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Provider delivery identity and event type are required",
		});
	}
	if (input.projectId) {
		const project = await db.query.projects.findFirst({
			where: and(
				eq(projects.projectId, input.projectId),
				eq(projects.organizationId, input.organizationId),
			),
		});
		if (!project) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
		}
	}

	const payloadHash = createHash("sha256").update(input.rawBody).digest("hex");
	const [created] = await db
		.insert(providerDeliveries)
		.values({
			organizationId: input.organizationId,
			projectId: input.projectId,
			provider: input.provider,
			externalDeliveryId: input.externalDeliveryId,
			eventType: input.eventType,
			payloadHash,
		})
		.onConflictDoNothing({
			target: [
				providerDeliveries.organizationId,
				providerDeliveries.provider,
				providerDeliveries.externalDeliveryId,
			],
		})
		.returning();
	if (created) return { delivery: created, duplicate: false };

	const existing = await db.query.providerDeliveries.findFirst({
		where: and(
			eq(providerDeliveries.organizationId, input.organizationId),
			eq(providerDeliveries.provider, input.provider),
			eq(providerDeliveries.externalDeliveryId, input.externalDeliveryId),
		),
	});
	if (!existing) throw new Error("Provider delivery conflict could not be recovered");
	if (existing.payloadHash !== payloadHash || existing.eventType !== input.eventType) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Provider reused a delivery identifier with different content",
		});
	}
	return { delivery: existing, duplicate: true };
};

export interface UpdateProviderDeliveryInput {
	organizationId: string;
	providerDeliveryId: string;
	expectedStatus: (typeof providerDeliveryStatus.enumValues)[number];
	nextStatus: (typeof providerDeliveryStatus.enumValues)[number];
	errorCode?: string | null;
	errorMessage?: string | null;
}

const deliveryTransitions: Record<
	(typeof providerDeliveryStatus.enumValues)[number],
	readonly (typeof providerDeliveryStatus.enumValues)[number][]
> = {
	received: ["processing", "ignored", "failed"],
	processing: ["processed", "ignored", "failed"],
	processed: [],
	ignored: [],
	failed: [],
};

export const transitionProviderDelivery = async (
	input: UpdateProviderDeliveryInput,
) => {
	if (!deliveryTransitions[input.expectedStatus].includes(input.nextStatus)) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `Invalid provider delivery transition: ${input.expectedStatus} -> ${input.nextStatus}`,
		});
	}
	const terminal = ["processed", "ignored", "failed"].includes(input.nextStatus);
	const [updated] = await db
		.update(providerDeliveries)
		.set({
			status: input.nextStatus,
			errorCode: input.errorCode,
			errorMessage: input.errorMessage,
			processedAt: terminal ? new Date() : undefined,
		})
		.where(
			and(
				eq(
					providerDeliveries.providerDeliveryId,
					input.providerDeliveryId,
				),
				eq(providerDeliveries.organizationId, input.organizationId),
				eq(providerDeliveries.status, input.expectedStatus),
			),
		)
		.returning();
	if (updated) return updated;
	throw new TRPCError({
		code: "CONFLICT",
		message: "Provider delivery changed while processing",
	});
};
