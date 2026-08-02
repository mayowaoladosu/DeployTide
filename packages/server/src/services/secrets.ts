import { db } from "@dokploy/server/db";
import {
	environments,
	environmentVariables,
	projects,
	secretVersions,
	type variableExposure,
	type variableScope,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { digestSecretValue } from "../lib/sensitive-digest";
import { startOperation, transitionOperation } from "./operations";

export type VariableScope = (typeof variableScope.enumValues)[number];
export type VariableExposure = (typeof variableExposure.enumValues)[number];

export interface PutSecretInput {
	organizationId: string;
	projectId?: string;
	environmentId?: string;
	scope: VariableScope;
	key: string;
	value: string;
	exposure?: VariableExposure;
	sensitive?: boolean;
	actorId?: string;
	idempotencyKey: string;
}

export const assertVariableScope = (
	input: Pick<PutSecretInput, "scope" | "projectId" | "environmentId">,
) => {
	const valid =
		(input.scope === "workspace" && !input.projectId && !input.environmentId) ||
		(input.scope === "project" && !!input.projectId && !input.environmentId) ||
		(input.scope === "environment" &&
			!!input.projectId &&
			!!input.environmentId);
	if (!valid) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Variable scope does not match its project/environment target",
		});
	}
};

export const putSecret = async (input: PutSecretInput) => {
	assertVariableScope(input);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.key)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Variable key must be a valid environment variable name",
		});
	}

	return db.transaction(async (transaction) => {
		const valueDigest = digestSecretValue(input.value);
		await transaction.execute(
			sql`select pg_advisory_xact_lock(hashtext(${`${input.organizationId}:${input.scope}:${input.projectId ?? ""}:${input.environmentId ?? ""}:${input.key}`}))`,
		);

		if (input.projectId) {
			const project = await transaction.query.projects.findFirst({
				where: and(
					eq(projects.projectId, input.projectId),
					eq(projects.organizationId, input.organizationId),
				),
			});
			if (!project) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
			}
		}
		if (input.environmentId) {
			const environment = await transaction.query.environments.findFirst({
				where: and(
					eq(environments.environmentId, input.environmentId),
					eq(environments.projectId, input.projectId as string),
					eq(environments.organizationId, input.organizationId),
				),
			});
			if (!environment) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Environment not found",
				});
			}
		}

		const conditions = [
			eq(environmentVariables.organizationId, input.organizationId),
			eq(environmentVariables.scope, input.scope),
			eq(environmentVariables.key, input.key),
			input.projectId
				? eq(environmentVariables.projectId, input.projectId)
				: isNull(environmentVariables.projectId),
			input.environmentId
				? eq(environmentVariables.environmentId, input.environmentId)
				: isNull(environmentVariables.environmentId),
		];
		const operation = await startOperation(
			{
				organizationId: input.organizationId,
				idempotencyKey: input.idempotencyKey,
				kind: "secret.put",
				actorType: input.actorId ? "user" : "system",
				actorId: input.actorId,
				resourceType: "environmentVariable",
				resourceId: `${input.scope}:${input.projectId ?? ""}:${input.environmentId ?? ""}:${input.key}`,
				input: {
					scope: input.scope,
					projectId: input.projectId,
					environmentId: input.environmentId,
					key: input.key,
					exposure: input.exposure ?? "runtime",
					sensitive: input.sensitive ?? true,
					valueDigest,
				},
			},
			transaction,
		);
		if (operation.status === "succeeded") {
			const existing = await transaction.query.environmentVariables.findFirst({
				where: and(...conditions),
			});
			if (!existing) throw new Error("Completed secret operation has no variable");
			return { ...existing, value: undefined };
		}
		if (operation.status !== "pending") {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Secret mutation is already in progress",
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

		let variable = await transaction.query.environmentVariables.findFirst({
			where: and(...conditions),
		});
		const nextVersion = variable ? variable.currentVersion + 1 : 1;

		if (!variable) {
			[variable] = await transaction
				.insert(environmentVariables)
				.values({
					organizationId: input.organizationId,
					projectId: input.projectId,
					environmentId: input.environmentId,
					scope: input.scope,
					key: input.key,
					exposure: input.exposure ?? "runtime",
					sensitive: input.sensitive ?? true,
					currentVersion: nextVersion,
					createdBy: input.actorId,
				})
				.returning();
		} else {
			[variable] = await transaction
				.update(environmentVariables)
				.set({
					exposure: input.exposure ?? variable.exposure,
					sensitive: input.sensitive ?? variable.sensitive,
					currentVersion: nextVersion,
					updatedAt: new Date(),
					deletedAt: null,
				})
				.where(
					eq(
					environmentVariables.environmentVariableId,
					variable.environmentVariableId,
				),
				)
				.returning();
		}
		if (!variable) throw new Error("Failed to persist variable metadata");

		await transaction.insert(secretVersions).values({
			environmentVariableId: variable.environmentVariableId,
			version: nextVersion,
			value: input.value,
			valueDigest,
			operationId: operation.operationId,
			createdBy: input.actorId,
		});
		await transitionOperation(
			{
				organizationId: input.organizationId,
				operationId: operation.operationId,
				expectedStatus: "running",
				nextStatus: "succeeded",
				result: {
					environmentVariableId: variable.environmentVariableId,
					version: nextVersion,
				},
			},
			transaction,
		);
		return { ...variable, value: undefined };
	});
};
