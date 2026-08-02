import { db } from "@dokploy/server/db";
import {
	type MetricsConfig,
	webServerSettings,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";

const defaultMetricsConfig: MetricsConfig = {
	server: {
		type: "Dokploy",
		refreshRate: 60,
		port: 4500,
		token: "",
		retentionDays: 2,
		cronJob: "",
		urlCallback: "",
		thresholds: { cpu: 0, memory: 0 },
	},
	containers: {
		refreshRate: 60,
		services: { include: [], exclude: [] },
	},
};

/**
 * Get the web server settings (singleton - only one row should exist)
 */
export const getWebServerSettings = async () => {
	const settings = await db.query.webServerSettings.findFirst({
		orderBy: (settings, { asc }) => [asc(settings.createdAt)],
	});

	if (!settings) {
		// Create default settings if none exist
		const [newSettings] = await db
			.insert(webServerSettings)
			.values({ metricsConfig: defaultMetricsConfig })
			.returning();

		return newSettings;
	}

	return settings;
};

/**
 * Update web server settings
 */
export const updateWebServerSettings = async (
	updates: Partial<typeof webServerSettings.$inferInsert>,
) => {
	const current = await getWebServerSettings();

	const [updated] = await db
		.update(webServerSettings)
		.set({
			...updates,
			updatedAt: new Date(),
		})
		.where(eq(webServerSettings.id, current?.id ?? ""))
		.returning();

	return updated;
};
