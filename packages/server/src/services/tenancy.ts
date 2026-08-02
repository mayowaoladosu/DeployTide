import { db } from "@dokploy/server/db";
import {
	aliases,
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
	organization,
	postgres,
	previewDeployments,
	projectSources,
	projects,
	redis,
	rollbacks,
	server,
	session,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";

export interface WorkspaceOwnedResource {
	organizationId: string | null;
}

export const assertWorkspaceResource = <T extends WorkspaceOwnedResource>(
	organizationId: string,
	resource: T | null | undefined,
	resourceName = "Resource",
): T => {
	if (!organizationId || !resource || resource.organizationId !== organizationId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `${resourceName} not found`,
		});
	}
	return resource;
};

export type DatabaseTransaction = Parameters<
	Parameters<typeof db.transaction>[0]
>[0];

export const resolveEnvironmentOwnership = async (
	executor: DatabaseTransaction | typeof db,
	environmentId: string,
	expectedOrganizationId?: string,
) => {
	const environment = await executor.query.environments.findFirst({
		where: and(
			eq(environments.environmentId, environmentId),
			isNull(environments.deletedAt),
		),
		columns: {
			environmentId: true,
			projectId: true,
			organizationId: true,
		},
		with: {
			project: {
				columns: { organizationId: true, deletedAt: true },
			},
		},
	});
	const organizationId =
		environment?.organizationId ?? environment?.project.organizationId;
	if (
		!environment ||
		environment.project.deletedAt ||
		!organizationId ||
		(expectedOrganizationId && organizationId !== expectedOrganizationId)
	) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Environment not found" });
	}
	return {
		organizationId,
		projectId: environment.projectId,
		environmentId: environment.environmentId,
	};
};

export const withWorkspaceTransaction = async <T>(
	organizationId: string,
	callback: (transaction: DatabaseTransaction) => Promise<T>,
): Promise<T> => {
	if (!organizationId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Active workspace is required",
		});
	}
	return db.transaction(callback);
};

export interface WorkspaceServiceRuntime {
	serviceId: string;
	appName: string;
	serverId: string | null;
	type:
		| "application"
		| "compose"
		| "postgres"
		| "mariadb"
		| "mysql"
		| "mongo"
		| "redis"
		| "libsql";
}

export const findWorkspaceServiceRuntime = async (
	organizationId: string,
	serviceId: string,
): Promise<WorkspaceServiceRuntime> => {
	const application = await db.query.applications.findFirst({
		where: and(
			eq(applications.applicationId, serviceId),
			eq(applications.organizationId, organizationId),
			isNull(applications.deletedAt),
		),
		columns: { applicationId: true, appName: true, serverId: true },
		with: { environment: { with: { project: true } } },
	});
	if (
		application &&
		!application.environment.deletedAt &&
		!application.environment.project.deletedAt
	) {
		return {
			serviceId: application.applicationId,
			appName: application.appName,
			serverId: application.serverId,
			type: "application",
		};
	}

	const candidates = await Promise.all([
		db.query.compose.findFirst({
			where: and(
				eq(compose.composeId, serviceId),
				eq(compose.organizationId, organizationId),
				isNull(compose.deletedAt),
			),
			columns: { composeId: true, appName: true, serverId: true },
			with: { environment: { with: { project: true } } },
		}),
		db.query.postgres.findFirst({
			where: and(
				eq(postgres.postgresId, serviceId),
				eq(postgres.organizationId, organizationId),
			),
			columns: { postgresId: true, appName: true, serverId: true },
			with: { environment: { with: { project: true } } },
		}),
		db.query.mariadb.findFirst({
			where: and(
				eq(mariadb.mariadbId, serviceId),
				eq(mariadb.organizationId, organizationId),
			),
			columns: { mariadbId: true, appName: true, serverId: true },
			with: { environment: { with: { project: true } } },
		}),
		db.query.mysql.findFirst({
			where: and(
				eq(mysql.mysqlId, serviceId),
				eq(mysql.organizationId, organizationId),
			),
			columns: { mysqlId: true, appName: true, serverId: true },
			with: { environment: { with: { project: true } } },
		}),
		db.query.mongo.findFirst({
			where: and(
				eq(mongo.mongoId, serviceId),
				eq(mongo.organizationId, organizationId),
			),
			columns: { mongoId: true, appName: true, serverId: true },
			with: { environment: { with: { project: true } } },
		}),
		db.query.redis.findFirst({
			where: and(
				eq(redis.redisId, serviceId),
				eq(redis.organizationId, organizationId),
			),
			columns: { redisId: true, appName: true, serverId: true },
			with: { environment: { with: { project: true } } },
		}),
		db.query.libsql.findFirst({
			where: and(
				eq(libsql.libsqlId, serviceId),
				eq(libsql.organizationId, organizationId),
			),
			columns: { libsqlId: true, appName: true, serverId: true },
			with: { environment: { with: { project: true } } },
		}),
	]);
	const types = [
		"compose",
		"postgres",
		"mariadb",
		"mysql",
		"mongo",
		"redis",
		"libsql",
	] as const;
	for (const [index, candidate] of candidates.entries()) {
		if (
			candidate &&
			!candidate.environment.deletedAt &&
			!candidate.environment.project.deletedAt &&
			candidate.environment.organizationId === organizationId
		) {
			const type = types[index]!;
			const id =
				"composeId" in candidate
					? candidate.composeId
					: "postgresId" in candidate
						? candidate.postgresId
						: "mariadbId" in candidate
							? candidate.mariadbId
							: "mysqlId" in candidate
								? candidate.mysqlId
								: "mongoId" in candidate
									? candidate.mongoId
									: "redisId" in candidate
										? candidate.redisId
										: candidate.libsqlId;
			return {
				serviceId: id,
				appName: candidate.appName,
				serverId: candidate.serverId,
				type,
			};
		}
	}
	throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });
};

export const softDeleteWorkspace = async (organizationId: string) => {
	const deletedAt = new Date();
	return db.transaction(async (transaction) => {
		const [workspace] = await transaction
			.update(organization)
			.set({ deletedAt })
			.where(
				and(
					eq(organization.id, organizationId),
					isNull(organization.deletedAt),
				),
			)
			.returning();
		if (!workspace) return null;

		await Promise.all([
			transaction
				.update(session)
				.set({ activeOrganizationId: null, updatedAt: deletedAt })
				.where(eq(session.activeOrganizationId, organizationId)),
			transaction
				.update(projects)
				.set({ deletedAt })
				.where(and(eq(projects.organizationId, organizationId), isNull(projects.deletedAt))),
			transaction
				.update(environments)
				.set({ deletedAt })
				.where(and(eq(environments.organizationId, organizationId), isNull(environments.deletedAt))),
			transaction
				.update(applications)
				.set({ deletedAt })
				.where(and(eq(applications.organizationId, organizationId), isNull(applications.deletedAt))),
			transaction
				.update(compose)
				.set({ deletedAt, autoDeploy: false, refreshTokenDigest: null })
				.where(
					and(isNull(compose.deletedAt), sql`${compose.environmentId} IN (
						SELECT ${environments.environmentId}
						FROM ${environments}
						WHERE ${environments.organizationId} = ${organizationId}
					)`),
				),
			transaction
				.update(server)
				.set({ deletedAt, serverStatus: "inactive" })
				.where(
					and(
						eq(server.organizationId, organizationId),
						isNull(server.deletedAt),
					),
				),
			transaction
				.update(deployments)
				.set({ deletedAt })
				.where(and(eq(deployments.organizationId, organizationId), isNull(deployments.deletedAt))),
			transaction
				.update(domains)
				.set({ deletedAt })
				.where(and(eq(domains.organizationId, organizationId), isNull(domains.deletedAt))),
			transaction
				.update(previewDeployments)
				.set({ deletedAt })
				.where(and(eq(previewDeployments.organizationId, organizationId), isNull(previewDeployments.deletedAt))),
			transaction
				.update(rollbacks)
				.set({ deletedAt })
				.where(and(eq(rollbacks.organizationId, organizationId), isNull(rollbacks.deletedAt))),
			transaction
				.update(environmentVariables)
				.set({ deletedAt, updatedAt: deletedAt })
				.where(and(eq(environmentVariables.organizationId, organizationId), isNull(environmentVariables.deletedAt))),
			transaction
				.update(projectSources)
				.set({ enabled: false, updatedAt: deletedAt })
				.where(eq(projectSources.organizationId, organizationId)),
			transaction
				.update(aliases)
				.set({ status: "disabled", updatedAt: deletedAt })
				.where(eq(aliases.organizationId, organizationId)),
		]);
		return workspace;
	});
};

export const findWorkspaceProject = async (
	organizationId: string,
	projectId: string,
) => {
	const project = await db.query.projects.findFirst({
		where: and(
			eq(projects.projectId, projectId),
			eq(projects.organizationId, organizationId),
			isNull(projects.deletedAt),
		),
	});
	return assertWorkspaceResource(organizationId, project, "Project");
};

export const findWorkspaceDeployment = async (
	organizationId: string,
	deploymentId: string,
) => {
	const deployment = await db.query.deployments.findFirst({
		where: and(
			eq(deployments.deploymentId, deploymentId),
			eq(deployments.organizationId, organizationId),
			isNull(deployments.deletedAt),
		),
		with: {
			previewDeployment: {
				columns: { applicationId: true },
			},
		},
	});
	return assertWorkspaceResource(organizationId, deployment, "Deployment");
};

export const findWorkspaceEnvironment = async (
	organizationId: string,
	environmentId: string,
) => {
	const environment = await db.query.environments.findFirst({
		where: and(
			eq(environments.environmentId, environmentId),
			eq(environments.organizationId, organizationId),
			isNull(environments.deletedAt),
		),
	});
	return assertWorkspaceResource(organizationId, environment, "Environment");
};

export const findWorkspaceDomain = async (
	organizationId: string,
	domainId: string,
) => {
	const domain = await db.query.domains.findFirst({
		where: and(
			eq(domains.domainId, domainId),
			eq(domains.organizationId, organizationId),
			isNull(domains.deletedAt),
		),
	});
	return assertWorkspaceResource(organizationId, domain, "Domain");
};

export const findWorkspaceProjectSource = async (
	organizationId: string,
	projectSourceId: string,
) => {
	const source = await db.query.projectSources.findFirst({
		where: and(
			eq(projectSources.projectSourceId, projectSourceId),
			eq(projectSources.organizationId, organizationId),
		),
	});
	return assertWorkspaceResource(organizationId, source, "Project source");
};
