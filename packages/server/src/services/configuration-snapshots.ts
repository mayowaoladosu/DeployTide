import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	configurationSnapshotSecretVersions,
	configurationSnapshots,
	environments,
	environmentVariables,
	secretVersions,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, or } from "drizzle-orm";
import type { DatabaseTransaction } from "./tenancy";

type Executor = DatabaseTransaction | typeof db;

export interface CreateConfigurationSnapshotInput {
	organizationId: string;
	projectId: string;
	environmentId: string;
	serviceType: string;
	serviceId: string;
	sourceConfig?: Record<string, unknown> | null;
	buildConfig?: Record<string, unknown> | null;
	runtimeConfig?: Record<string, unknown> | null;
}

const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

const scopePriority = {
	workspace: 0,
	project: 1,
	environment: 2,
} as const;

export const createConfigurationSnapshot = async (
	input: CreateConfigurationSnapshotInput,
	executor: Executor = db,
) => {
	const environment = await executor.query.environments.findFirst({
		where: and(
			eq(environments.environmentId, input.environmentId),
			eq(environments.projectId, input.projectId),
			eq(environments.organizationId, input.organizationId),
			isNull(environments.deletedAt),
		),
		columns: { environmentId: true },
	});
	if (!environment) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Environment not found",
		});
	}

	const candidates = await executor
		.select({
			environmentVariableId: environmentVariables.environmentVariableId,
			secretVersionId: secretVersions.secretVersionId,
			key: environmentVariables.key,
			exposure: environmentVariables.exposure,
			scope: environmentVariables.scope,
		})
		.from(environmentVariables)
		.innerJoin(
			secretVersions,
			and(
				eq(
					secretVersions.environmentVariableId,
					environmentVariables.environmentVariableId,
				),
				eq(secretVersions.version, environmentVariables.currentVersion),
			),
		)
		.where(
			and(
				eq(environmentVariables.organizationId, input.organizationId),
				isNull(environmentVariables.deletedAt),
				or(
					eq(environmentVariables.scope, "workspace"),
					and(
						eq(environmentVariables.scope, "project"),
						eq(environmentVariables.projectId, input.projectId),
					),
					and(
						eq(environmentVariables.scope, "environment"),
						eq(environmentVariables.projectId, input.projectId),
						eq(environmentVariables.environmentId, input.environmentId),
					),
				),
			),
		);

	const effectiveByKey = new Map<string, (typeof candidates)[number]>();
	for (const candidate of candidates.sort(
		(left, right) =>
			scopePriority[left.scope] - scopePriority[right.scope] ||
			left.key.localeCompare(right.key),
	)) {
		effectiveByKey.set(candidate.key, candidate);
	}
	const effectiveSecrets = [...effectiveByKey.values()].sort((left, right) =>
		left.key.localeCompare(right.key),
	);

	const sourceConfig = input.sourceConfig ?? {};
	const buildConfig = input.buildConfig ?? {};
	const runtimeConfig = input.runtimeConfig ?? {};
	const contentDigest = createHash("sha256")
		.update(
			canonicalJson({
				organizationId: input.organizationId,
				projectId: input.projectId,
				environmentId: input.environmentId,
				serviceType: input.serviceType,
				serviceId: input.serviceId,
				sourceConfig,
				buildConfig,
				runtimeConfig,
				secrets: effectiveSecrets.map((secret) => ({
					key: secret.key,
					exposure: secret.exposure,
					environmentVariableId: secret.environmentVariableId,
					secretVersionId: secret.secretVersionId,
				})),
			}),
		)
		.digest("hex");

	const [snapshot] = await executor
		.insert(configurationSnapshots)
		.values({
			organizationId: input.organizationId,
			projectId: input.projectId,
			environmentId: input.environmentId,
			serviceType: input.serviceType,
			serviceId: input.serviceId,
			sourceConfig,
			buildConfig,
			runtimeConfig,
			contentDigest,
		})
		.returning();
	if (!snapshot) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to create configuration snapshot",
		});
	}

	if (effectiveSecrets.length > 0) {
		await executor.insert(configurationSnapshotSecretVersions).values(
			effectiveSecrets.map((secret) => ({
				configurationSnapshotId: snapshot.configurationSnapshotId,
				organizationId: input.organizationId,
				environmentVariableId: secret.environmentVariableId,
				secretVersionId: secret.secretVersionId,
				key: secret.key,
				exposure: secret.exposure,
			})),
		);
	}

	return snapshot;
};
