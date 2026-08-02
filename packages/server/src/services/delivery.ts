import { db } from "@dokploy/server/db";
import {
	aliases,
	builds,
	deployments,
	releases,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import {
	assertStateTransition,
	type BuildState,
	buildTransitions,
	type DeploymentState,
	deploymentTransitions,
	type ReleaseState,
	releaseTransitions,
} from "./state-machines/delivery";
import type { DatabaseTransaction } from "./tenancy";

type Executor = DatabaseTransaction | typeof db;

const transitionConflict = (resource: string) =>
	new TRPCError({
		code: "CONFLICT",
		message: `${resource} changed while its state transition was in progress`,
	});

export interface TransitionDeploymentInput {
	organizationId: string;
	deploymentId: string;
	expectedStatus: DeploymentState;
	nextStatus: DeploymentState;
	errorCode?: string | null;
	errorMessage?: string | null;
}

export const transitionDeployment = async (
	input: TransitionDeploymentInput,
	executor: Executor = db,
) => {
	assertStateTransition(
		"deployment",
		deploymentTransitions,
		input.expectedStatus,
		input.nextStatus,
	);
	const terminal = ["ready", "failed", "cancelled"].includes(input.nextStatus);
	const [updated] = await executor
		.update(deployments)
		.set({
			status: input.nextStatus,
			errorCode: input.errorCode,
			errorMessage: input.errorMessage,
			finishedAt: terminal ? new Date().toISOString() : null,
		})
		.where(
			and(
				eq(deployments.deploymentId, input.deploymentId),
				eq(deployments.organizationId, input.organizationId),
				eq(deployments.status, input.expectedStatus),
			),
		)
		.returning();
	if (updated) return updated;

	const current = await executor.query.deployments.findFirst({
		where: and(
			eq(deployments.deploymentId, input.deploymentId),
			eq(deployments.organizationId, input.organizationId),
		),
	});
	if (!current) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Deployment not found" });
	}
	throw transitionConflict("Deployment");
};

export interface TransitionBuildInput {
	organizationId: string;
	buildId: string;
	expectedStatus: BuildState;
	nextStatus: BuildState;
	workerRef?: string | null;
	errorCode?: string | null;
	errorMessage?: string | null;
}

export const transitionBuild = async (
	input: TransitionBuildInput,
	executor: Executor = db,
) => {
	assertStateTransition(
		"build",
		buildTransitions,
		input.expectedStatus,
		input.nextStatus,
	);
	const now = new Date();
	const terminal = ["succeeded", "failed", "cancelled"].includes(
		input.nextStatus,
	);
	const [updated] = await executor
		.update(builds)
		.set({
			status: input.nextStatus,
			workerRef: input.workerRef,
			errorCode: input.errorCode,
			errorMessage: input.errorMessage,
			startedAt: input.nextStatus === "running" ? now : undefined,
			finishedAt: terminal ? now : undefined,
		})
		.where(
			and(
				eq(builds.buildId, input.buildId),
				eq(builds.organizationId, input.organizationId),
				eq(builds.status, input.expectedStatus),
			),
		)
		.returning();
	if (updated) return updated;

	const current = await executor.query.builds.findFirst({
		where: and(
			eq(builds.buildId, input.buildId),
			eq(builds.organizationId, input.organizationId),
		),
	});
	if (!current) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Build not found" });
	}
	throw transitionConflict("Build");
};

export interface TransitionReleaseInput {
	organizationId: string;
	releaseId: string;
	expectedStatus: ReleaseState;
	nextStatus: ReleaseState;
	runtimePlacementId?: string | null;
	healthResult?: Record<string, unknown> | null;
	failureCode?: string | null;
	failureMessage?: string | null;
}

export const transitionRelease = async (
	input: TransitionReleaseInput,
	executor: Executor = db,
) => {
	assertStateTransition(
		"release",
		releaseTransitions,
		input.expectedStatus,
		input.nextStatus,
	);
	if (input.nextStatus === "retired") {
		const activeAlias = await executor.query.aliases.findFirst({
			where: and(
				eq(aliases.organizationId, input.organizationId),
				eq(aliases.releaseId, input.releaseId),
			),
		});
		if (activeAlias && activeAlias.status !== "disabled") {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "A release targeted by an active alias cannot be retired",
			});
		}
	}
	const now = new Date();
	const [updated] = await executor
		.update(releases)
		.set({
			status: input.nextStatus,
			runtimePlacementId: input.runtimePlacementId,
			healthResult: input.healthResult,
			failureCode: input.failureCode,
			failureMessage: input.failureMessage,
			deployingAt: input.nextStatus === "deploying" ? now : undefined,
			readyAt: input.nextStatus === "ready" ? now : undefined,
			failedAt: input.nextStatus === "failed" ? now : undefined,
			retiredAt: input.nextStatus === "retired" ? now : undefined,
		})
		.where(
			and(
				eq(releases.releaseId, input.releaseId),
				eq(releases.organizationId, input.organizationId),
				eq(releases.status, input.expectedStatus),
			),
		)
		.returning();
	if (updated) return updated;

	const current = await executor.query.releases.findFirst({
		where: and(
			eq(releases.releaseId, input.releaseId),
			eq(releases.organizationId, input.organizationId),
		),
	});
	if (!current) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Release not found" });
	}
	throw transitionConflict("Release");
};
