import { db } from "@dokploy/server/db";
import { outboxEvents } from "@dokploy/server/db/schema";
import type { DatabaseTransaction } from "./tenancy";

export interface EnqueueOutboxEventInput {
	organizationId: string;
	operationId?: string;
	dedupeKey: string;
	eventType: string;
	aggregateType: string;
	aggregateId: string;
	payload: Record<string, unknown>;
	availableAt?: Date;
}

export const enqueueOutboxEvent = async (
	input: EnqueueOutboxEventInput,
	transaction: DatabaseTransaction | typeof db = db,
) => {
	const [created] = await transaction
		.insert(outboxEvents)
		.values(input)
		.onConflictDoNothing({
			target: [outboxEvents.organizationId, outboxEvents.dedupeKey],
		})
		.returning();
	return created ?? null;
};
