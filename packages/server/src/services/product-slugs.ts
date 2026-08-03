import { db } from "@dokploy/server/db";
import { organization, projects } from "@dokploy/server/db/schema";
import { and, eq, ne } from "drizzle-orm";

export const toProductSlug = (value: string): string => {
	const normalized = value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 54)
		.replace(/-+$/g, "");
	return normalized || "project";
};

export const createUniqueProjectSlug = async (
	organizationId: string,
	requested: string,
	excludeProjectId?: string,
): Promise<string> => {
	const base = toProductSlug(requested);
	for (let attempt = 1; attempt <= 999; attempt++) {
		const candidate = attempt === 1 ? base : `${base}-${attempt}`;
		const existing = await db.query.projects.findFirst({
			where: and(
				eq(projects.organizationId, organizationId),
				eq(projects.slug, candidate),
				...(excludeProjectId
					? [ne(projects.projectId, excludeProjectId)]
					: []),
			),
			columns: { projectId: true },
		});
		if (!existing) return candidate;
	}
	throw new Error("Could not allocate a unique project slug");
};

export const createUniqueWorkspaceSlug = async (
	requested: string,
): Promise<string> => {
	const base = toProductSlug(requested).replace(/^project$/, "workspace");
	for (let attempt = 1; attempt <= 999; attempt++) {
		const candidate = attempt === 1 ? base : `${base}-${attempt}`;
		const existing = await db.query.organization.findFirst({
			where: eq(organization.slug, candidate),
			columns: { id: true },
		});
		if (!existing) return candidate;
	}
	throw new Error("Could not allocate a unique workspace slug");
};