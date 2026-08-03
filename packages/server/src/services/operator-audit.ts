import { db } from "@dokploy/server/db";
import { operatorAuditLog } from "@dokploy/server/db/schema";
import type { DatabaseTransaction } from "./tenancy";

const forbiddenMetadataKey =
	/(secret|token|password|private.?key|credential|endpoint|pem|certificate|reference|environment|payload|signature|diagnostic|log|machine)/i;
const forbiddenMetadataValue =
	/(?:^|\b)(?:env|file|https?|ssh|docker):\/\/|-----BEGIN |bearer\s+|(?:secret|token|password|private.?key)\s*[:=]/i;

export interface OperatorAuditInput {
	actorUserId: string;
	actorEmail: string;
	action: string;
	resourceType: string;
	resourceId?: string | null;
	requestId?: string | null;
	metadata?: Record<string, string | number | boolean>;
}

export const assertSafeOperatorAuditMetadata = (
	metadata: OperatorAuditInput["metadata"],
) => {
	for (const [key, value] of Object.entries(metadata ?? {})) {
		if (
			forbiddenMetadataKey.test(key) ||
			(typeof value === "string" &&
				(value.length > 256 || forbiddenMetadataValue.test(value)))
		) {
			throw new Error("Operator audit metadata is not safe");
		}
	}
};

export const recordOperatorAudit = async (
	input: OperatorAuditInput,
	executor: DatabaseTransaction | typeof db = db,
) => {
	assertSafeOperatorAuditMetadata(input.metadata);
	const [entry] = await executor
		.insert(operatorAuditLog)
		.values(input)
		.returning();
	if (!entry) throw new Error("Operator audit entry was not recorded");
	return entry;
};
