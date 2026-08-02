import { logger } from "../lib/logger";

export interface ActivityEvent {
	organizationId: string;
	userId: string;
	userEmail: string;
	userRole: string;
	action: string;
	resourceType: string;
	resourceId?: string;
	resourceName?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Emits a lightweight, structured activity event without coupling core actions
 * to a licensed persistence feature. Metadata values are deliberately omitted
 * so secrets cannot be copied into operational logs by mistake.
 */
export const recordActivity = async (event: ActivityEvent): Promise<void> => {
	const { metadata, ...fields } = event;
	logger.info(
		{
			event: "deploytide.activity",
			...fields,
			metadataKeys: metadata ? Object.keys(metadata) : undefined,
		},
		"DeployTide activity",
	);
};
