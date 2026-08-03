import { db } from "@dokploy/server/db";
import {
	aliases,
	type apiCreateProject,
	applications,
	compose,
	deployments,
	domains,
	environments,
	environmentVariables,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	previewDeployments,
	projectSources,
	projects,
	redis,
	rollbacks,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { createUniqueProjectSlug } from "./product-slugs";

export type Project = typeof projects.$inferSelect;

export const createProject = async (
	input: z.infer<typeof apiCreateProject>,
	organizationId: string,
) => {
	const slug = await createUniqueProjectSlug(
		organizationId,
		input.slug || input.name,
	);
	return db.transaction(async (transaction) => {
		const [newProject] = await transaction
			.insert(projects)
			.values({
				...input,
				slug,
				organizationId,
			})
			.returning();

		if (!newProject) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the project",
			});
		}

		const [newEnvironment] = await transaction
			.insert(environments)
			.values({
				name: "production",
				description: "Production environment",
				projectId: newProject.projectId,
				organizationId,
				isDefault: true,
				kind: "production",
			})
			.returning();

		if (!newEnvironment) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the production environment",
			});
		}

		return { project: newProject, environment: newEnvironment };
	});
};

export const findProjectById = async (projectId: string) => {
	const serviceColumns = {
		name: true,
		description: true,
		appName: true,
		createdAt: true,
		serverId: true,
		applicationStatus: true,
	} as const;

	const project = await db.query.projects.findFirst({
		where: and(
			eq(projects.projectId, projectId),
			isNull(projects.deletedAt),
		),
		with: {
			environments: {
				where: isNull(environments.deletedAt),
				with: {
					applications: {
						where: isNull(applications.deletedAt),
						columns: {
							...serviceColumns,
							applicationId: true,
							icon: true,
						},
						with: { server: { columns: { name: true } } },
					},
					compose: {
						where: isNull(compose.deletedAt),
						columns: {
							...serviceColumns,
							composeId: true,
							composeStatus: true,
						},
						with: { server: { columns: { name: true } } },
					},
					libsql: {
						columns: { ...serviceColumns, libsqlId: true },
						with: { server: { columns: { name: true } } },
					},
					mariadb: {
						columns: { ...serviceColumns, mariadbId: true },
						with: { server: { columns: { name: true } } },
					},
					mongo: {
						columns: { ...serviceColumns, mongoId: true },
						with: { server: { columns: { name: true } } },
					},
					mysql: {
						columns: { ...serviceColumns, mysqlId: true },
						with: { server: { columns: { name: true } } },
					},
					postgres: {
						columns: { ...serviceColumns, postgresId: true },
						with: { server: { columns: { name: true } } },
					},
					redis: {
						columns: { ...serviceColumns, redisId: true },
						with: { server: { columns: { name: true } } },
					},
				},
			},
			projectTags: {
				with: {
					tag: true,
				},
			},
		},
	});
	if (!project) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Project not found",
		});
	}
	return project;
};

export const deleteProject = async (
	projectId: string,
	organizationId: string,
) => {
	const deletedAt = new Date();
	return db.transaction(async (transaction) => {
		const [project] = await transaction
			.update(projects)
			.set({ deletedAt })
			.where(
				and(
					eq(projects.projectId, projectId),
					eq(projects.organizationId, organizationId),
					isNull(projects.deletedAt),
				),
			)
			.returning();
		if (!project) return null;

		await Promise.all([
			transaction
				.update(environments)
				.set({ deletedAt })
				.where(eq(environments.projectId, projectId)),
			transaction
				.update(applications)
				.set({ deletedAt })
				.where(eq(applications.projectId, projectId)),
			transaction
				.update(compose)
				.set({ deletedAt, autoDeploy: false, refreshTokenDigest: null })
				.where(
					and(isNull(compose.deletedAt), sql`${compose.environmentId} IN (
						SELECT ${environments.environmentId}
						FROM ${environments}
						WHERE ${environments.projectId} = ${projectId}
					)`),
				),
			transaction
				.update(deployments)
				.set({ deletedAt })
				.where(eq(deployments.projectId, projectId)),
			transaction
				.update(domains)
				.set({ deletedAt })
				.where(eq(domains.projectId, projectId)),
			transaction
				.update(previewDeployments)
				.set({ deletedAt })
				.where(eq(previewDeployments.projectId, projectId)),
			transaction
				.update(rollbacks)
				.set({ deletedAt })
				.where(eq(rollbacks.projectId, projectId)),
			transaction
				.update(environmentVariables)
				.set({ deletedAt, updatedAt: deletedAt })
				.where(eq(environmentVariables.projectId, projectId)),
			transaction
				.update(projectSources)
				.set({ enabled: false, updatedAt: deletedAt })
				.where(eq(projectSources.projectId, projectId)),
			transaction
				.update(aliases)
				.set({ status: "disabled", updatedAt: deletedAt })
				.where(eq(aliases.projectId, projectId)),
		]);
		return project;
	});
};

export const updateProjectById = async (
	projectId: string,
	projectData: Partial<Project>,
) => {
	const result = await db
		.update(projects)
		.set({
			...projectData,
		})
		.where(eq(projects.projectId, projectId))
		.returning()
		.then((res) => res[0]);

	return result;
};

export const validUniqueServerAppName = async (appName: string) => {
	const query = await db.query.environments.findMany({
		columns: { environmentId: true },
		with: {
			applications: {
				where: eq(applications.appName, appName),
				columns: {
					appName: true,
				},
			},
			libsql: {
				where: eq(libsql.appName, appName),
				columns: {
					appName: true,
				},
			},
			mariadb: {
				where: eq(mariadb.appName, appName),
				columns: {
					appName: true,
				},
			},
			mongo: {
				where: eq(mongo.appName, appName),
				columns: {
					appName: true,
				},
			},
			mysql: {
				where: eq(mysql.appName, appName),
				columns: {
					appName: true,
				},
			},
			postgres: {
				where: eq(postgres.appName, appName),
				columns: {
					appName: true,
				},
			},
			redis: {
				where: eq(redis.appName, appName),
				columns: {
					appName: true,
				},
			},
		},
	});

	// Filter out items with non-empty fields
	const nonEmptyProjects = query.filter(
		(project) =>
			project.applications.length > 0 ||
			project.libsql.length > 0 ||
			project.mariadb.length > 0 ||
			project.mongo.length > 0 ||
			project.mysql.length > 0 ||
			project.postgres.length > 0 ||
			project.redis.length > 0,
	);

	return nonEmptyProjects.length === 0;
};
