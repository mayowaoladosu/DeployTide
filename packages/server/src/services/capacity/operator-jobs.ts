import { db } from "@dokploy/server/db";
import {
	capacityLeases,
	controllerCertificates,
	operations,
	operatorJobAttempts,
	runtimeClusters,
	runtimeTargets,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import {
	CONTROLLER_PROTOCOL_VERSION,
	type ControllerJobEnvelope,
	type ControllerJobKind,
	controllerJobResourceKey,
	encodeControllerJobPayload,
	signControllerJob,
} from "../../infrastructure/controller-protocol";

const secretKeyPattern =
	/(secret|token|password|private.?key|credential|authorization)/i;
const releaseJobKinds = new Set<ControllerJobKind>([
	"release_create",
	"release_health",
	"release_drain",
	"release_logs",
]);

const assertRedactedObject = (value: unknown, path = "request") => {
	if (!value || typeof value !== "object") return;
	for (const [key, nested] of Object.entries(value)) {
		if (secretKeyPattern.test(key)) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `${path} contains a forbidden secret-bearing field`,
			});
		}
		assertRedactedObject(nested, `${path}.${key}`);
	}
};

export const redactOperatorDiagnostics = (value: string | null | undefined) => {
	if (!value) return null;
	return value
		.replace(
			/(authorization|token|password|secret|private.?key)\s*[:=]\s*[^\s,;]+/gi,
			"$1=[redacted]",
		)
		.slice(0, 8_000);
};

export const enqueueRuntimeControllerJob = async (input: {
	operationId: string;
	capacityLeaseId: string;
	runtimeClusterId: string;
	kind: ControllerJobKind;
	request: Record<string, unknown>;
}) => {
	assertRedactedObject(input.request);
	encodeControllerJobPayload(input.kind, input.request);
	controllerJobResourceKey(input.kind, input.request, input.runtimeClusterId);
	return db.transaction(async (transaction) => {
		const now = new Date();
		await transaction.execute(sql`
			select "capacityLeaseId"
			from "capacityLease"
			where "capacityLeaseId" = ${input.capacityLeaseId}
			for update
		`);
		const lease = await transaction.query.capacityLeases.findFirst({
			where: and(
				eq(capacityLeases.capacityLeaseId, input.capacityLeaseId),
				eq(capacityLeases.operationId, input.operationId),
				eq(capacityLeases.runtimeClusterId, input.runtimeClusterId),
				eq(capacityLeases.kind, "runtime"),
				eq(capacityLeases.state, "active"),
				gt(capacityLeases.expiresAt, now),
			),
		});
		if (!lease) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message:
					"Runtime controller job requires an active fenced capacity lease",
			});
		}
		const operation = await transaction.query.operations.findFirst({
			where: and(
				eq(operations.operationId, lease.operationId),
				eq(operations.organizationId, lease.organizationId),
				eq(operations.status, "running"),
				eq(operations.leaseOwner, lease.leaseOwner),
				gt(operations.leaseExpiresAt, now),
			),
			columns: { operationId: true },
		});
		if (!operation) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Controller job operation claim is stale or inconsistent",
			});
		}
		const requestReleaseId =
			typeof input.request.releaseId === "string"
				? input.request.releaseId
				: null;
		if (
			releaseJobKinds.has(input.kind) &&
			(lease.leaseScope !== "workspace" ||
				!lease.releaseId ||
				lease.releaseId !== requestReleaseId)
		) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Release controller job does not match its leased release",
			});
		}
		if (!releaseJobKinds.has(input.kind) && lease.leaseScope !== "operator") {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Cluster controller jobs require an operator capacity lease",
			});
		}
		const cluster = await transaction.query.runtimeClusters.findFirst({
			where: and(
				eq(runtimeClusters.runtimeClusterId, input.runtimeClusterId),
				isNull(runtimeClusters.deletedAt),
			),
			columns: { runtimeClusterId: true, drainState: true },
		});
		if (
			!cluster ||
			(cluster.drainState !== "active" && input.kind === "release_create")
		) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Runtime cluster cannot accept this operation",
			});
		}
		const [attempt] = await transaction
			.insert(operatorJobAttempts)
			.values({
				operationId: input.operationId,
				capacityLeaseId: input.capacityLeaseId,
				runtimeClusterId: input.runtimeClusterId,
				kind: input.kind,
				fencingToken: lease.fencingToken,
				request: input.request,
			})
			.returning();
		if (!attempt)
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Controller job was not created",
			});
		return attempt;
	});
};

export const getNextSignedControllerJob = async (input: {
	runtimeClusterId: string;
	runtimeTargetId: string;
	afterSequence: number;
	privateKeyPem: string;
	now?: Date;
}) => {
	const now = input.now ?? new Date();
	const attempt = await db.query.operatorJobAttempts.findFirst({
		where: and(
			eq(operatorJobAttempts.runtimeClusterId, input.runtimeClusterId),
			inArray(operatorJobAttempts.status, [
				"queued",
				"acknowledged",
				"running",
			]),
			gt(operatorJobAttempts.sequence, input.afterSequence),
			sql`exists (
				select 1
				from "capacityLease" lease
				join "operation" operation
					on operation."operationId" = lease."operationId"
					and operation."organizationId" = lease."organizationId"
				where lease."capacityLeaseId" = ${operatorJobAttempts.capacityLeaseId}
					and lease."operationId" = ${operatorJobAttempts.operationId}
					and lease."runtimeClusterId" = ${operatorJobAttempts.runtimeClusterId}
					and lease."runtimeTargetId" = ${input.runtimeTargetId}
					and lease."fencingToken" = ${operatorJobAttempts.fencingToken}
					and lease.state = 'active'
					and lease."expiresAt" > ${now.toISOString()}::timestamptz
					and operation.status = 'running'
					and operation."leaseOwner" = lease."leaseOwner"
					and operation."leaseExpiresAt" > ${now.toISOString()}::timestamptz
			)`,
		),
		orderBy: asc(operatorJobAttempts.sequence),
	});
	if (!attempt) return null;
	const payload = encodeControllerJobPayload(attempt.kind, attempt.request);
	const unsigned: Omit<ControllerJobEnvelope, "signature"> = {
		version: CONTROLLER_PROTOCOL_VERSION,
		attemptId: attempt.operatorJobAttemptId,
		clusterId: input.runtimeClusterId,
		sequence: attempt.sequence,
		fencingToken: attempt.fencingToken,
		resourceKey: controllerJobResourceKey(
			attempt.kind,
			attempt.request,
			input.runtimeClusterId,
		),
		kind: attempt.kind,
		issuedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 60_000).toISOString(),
		payload,
	};
	const envelope = signControllerJob(unsigned, input.privateKeyPem);
	await db
		.update(operatorJobAttempts)
		.set({ signature: envelope.signature, updatedAt: now })
		.where(
			and(
				eq(
					operatorJobAttempts.operatorJobAttemptId,
					attempt.operatorJobAttemptId,
				),
				inArray(operatorJobAttempts.status, [
					"queued",
					"acknowledged",
					"running",
				]),
			),
		);
	return envelope;
};

type FencedControllerJobInput = {
	operatorJobAttemptId: string;
	runtimeClusterId: string;
	runtimeTargetId: string;
	fencingToken: number;
};

const fencedAttemptWhere = (input: FencedControllerJobInput) =>
	and(
		eq(operatorJobAttempts.operatorJobAttemptId, input.operatorJobAttemptId),
		eq(operatorJobAttempts.runtimeClusterId, input.runtimeClusterId),
		eq(operatorJobAttempts.fencingToken, input.fencingToken),
		sql`exists (
			select 1
			from "capacityLease" lease
			where lease."capacityLeaseId" = ${operatorJobAttempts.capacityLeaseId}
				and lease."runtimeTargetId" = ${input.runtimeTargetId}
				and lease."runtimeClusterId" = ${input.runtimeClusterId}
				and lease."operationId" = ${operatorJobAttempts.operationId}
				and lease."fencingToken" = ${input.fencingToken}
		)`,
	);

const findFencedAttempt = async (input: FencedControllerJobInput) => {
	const attempt = await db.query.operatorJobAttempts.findFirst({
		where: fencedAttemptWhere(input),
	});
	if (!attempt)
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Controller job not found",
		});
	return attempt;
};

const activeFencingTuple = (
	attempt: {
		capacityLeaseId: string;
		operationId: string;
		runtimeClusterId: string;
		fencingToken: number;
	},
	runtimeTargetId: string,
	now: Date,
) => sql`exists (
	select 1
	from "capacityLease" lease
	join "operation" operation
		on operation."operationId" = lease."operationId"
		and operation."organizationId" = lease."organizationId"
	where lease."capacityLeaseId" = ${attempt.capacityLeaseId}
		and lease."operationId" = ${attempt.operationId}
		and lease."runtimeClusterId" = ${attempt.runtimeClusterId}
		and lease."runtimeTargetId" = ${runtimeTargetId}
		and lease."fencingToken" = ${attempt.fencingToken}
		and lease.state = 'active'
		and lease."expiresAt" > ${now.toISOString()}::timestamptz
		and operation.status = 'running'
		and operation."leaseOwner" = lease."leaseOwner"
		and operation."leaseExpiresAt" > ${now.toISOString()}::timestamptz
)`;

export const acknowledgeControllerJob = async (input: {
	operatorJobAttemptId: string;
	runtimeClusterId: string;
	runtimeTargetId: string;
	fencingToken: number;
}) => {
	const attempt = await findFencedAttempt(input);
	if (
		["acknowledged", "running", "succeeded", "failed"].includes(attempt.status)
	) {
		return attempt;
	}
	const now = new Date();
	const [acknowledged] = await db
		.update(operatorJobAttempts)
		.set({ status: "acknowledged", acknowledgedAt: now, updatedAt: now })
		.where(
			and(
				eq(
					operatorJobAttempts.operatorJobAttemptId,
					input.operatorJobAttemptId,
				),
				eq(operatorJobAttempts.runtimeClusterId, input.runtimeClusterId),
				eq(operatorJobAttempts.fencingToken, input.fencingToken),
				eq(operatorJobAttempts.status, "queued"),
				activeFencingTuple(attempt, input.runtimeTargetId, now),
			),
		)
		.returning();
	if (!acknowledged) {
		const current = await findFencedAttempt(input);
		if (
			["acknowledged", "running", "succeeded", "failed"].includes(
				current.status,
			)
		) {
			return current;
		}
		throw new TRPCError({
			code: "CONFLICT",
			message: "Controller job cannot be acknowledged",
		});
	}
	return acknowledged;
};

export const reportControllerJobProgress = async (input: {
	operatorJobAttemptId: string;
	runtimeClusterId: string;
	runtimeTargetId: string;
	fencingToken: number;
	progress: Record<string, unknown>;
}) => {
	assertRedactedObject(input.progress, "progress");
	const attempt = await findFencedAttempt(input);
	const now = new Date();
	const [updated] = await db
		.update(operatorJobAttempts)
		.set({ status: "running", progress: input.progress, updatedAt: now })
		.where(
			and(
				eq(
					operatorJobAttempts.operatorJobAttemptId,
					input.operatorJobAttemptId,
				),
				eq(operatorJobAttempts.runtimeClusterId, input.runtimeClusterId),
				eq(operatorJobAttempts.fencingToken, input.fencingToken),
				inArray(operatorJobAttempts.status, ["acknowledged", "running"]),
				activeFencingTuple(attempt, input.runtimeTargetId, now),
			),
		)
		.returning();
	if (!updated)
		throw new TRPCError({
			code: "CONFLICT",
			message: "Controller job cannot accept progress",
		});
	return updated;
};

export const completeControllerJob = async (input: {
	operatorJobAttemptId: string;
	runtimeClusterId: string;
	runtimeTargetId: string;
	fencingToken: number;
	succeeded: boolean;
	result?: Record<string, unknown>;
	retryable?: boolean;
	diagnostics?: string;
}) => {
	assertRedactedObject(input.result, "result");
	const attempt = await findFencedAttempt(input);
	if (["succeeded", "failed"].includes(attempt.status)) return attempt;
	const retryable = !input.succeeded && input.retryable === true;
	return db.transaction(async (transaction) => {
		const now = new Date();
		const [completed] = await transaction
			.update(operatorJobAttempts)
			.set({
				status: input.succeeded ? "succeeded" : "failed",
				result: input.result,
				retryable,
				redactedDiagnostics: redactOperatorDiagnostics(input.diagnostics),
				updatedAt: now,
				completedAt: now,
			})
			.where(
				and(
					eq(
						operatorJobAttempts.operatorJobAttemptId,
						input.operatorJobAttemptId,
					),
					eq(operatorJobAttempts.runtimeClusterId, input.runtimeClusterId),
					eq(operatorJobAttempts.fencingToken, input.fencingToken),
					inArray(operatorJobAttempts.status, ["acknowledged", "running"]),
					activeFencingTuple(attempt, input.runtimeTargetId, now),
				),
			)
			.returning();
		if (!completed) {
			const current = await transaction.query.operatorJobAttempts.findFirst({
				where: fencedAttemptWhere(input),
			});
			if (current && ["succeeded", "failed"].includes(current.status)) {
				return current;
			}
			throw new TRPCError({
				code: "CONFLICT",
				message: "Controller job cannot be completed",
			});
		}
		if (retryable) {
			await transaction.insert(operatorJobAttempts).values({
				operationId: completed.operationId,
				capacityLeaseId: completed.capacityLeaseId,
				buildPoolId: completed.buildPoolId,
				runtimeClusterId: completed.runtimeClusterId,
				kind: completed.kind,
				fencingToken: completed.fencingToken,
				request: completed.request,
			});
		}
		return completed;
	});
};

export const heartbeatRuntimeController = async (input: {
	runtimeClusterId: string;
	runtimeTargetId: string;
	controllerVersion: string;
	health: "healthy" | "degraded" | "unavailable";
	now?: Date;
}) => {
	const now = input.now ?? new Date();
	return db.transaction(async (transaction) => {
		const cluster = await transaction.query.runtimeClusters.findFirst({
			where: and(
				eq(runtimeClusters.runtimeClusterId, input.runtimeClusterId),
				isNull(runtimeClusters.deletedAt),
			),
			columns: { runtimeClusterId: true },
		});
		if (!cluster) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Runtime cluster not found",
			});
		}
		const target = await transaction.query.runtimeTargets.findFirst({
			where: and(
				eq(runtimeTargets.runtimeTargetId, input.runtimeTargetId),
				eq(runtimeTargets.runtimeClusterId, input.runtimeClusterId),
				isNull(runtimeTargets.deletedAt),
			),
			columns: { runtimeTargetId: true },
		});
		if (!target) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Runtime target does not belong to this cluster",
			});
		}
		await transaction
			.update(runtimeTargets)
			.set({ health: input.health, lastHeartbeatAt: now, updatedAt: now })
			.where(
				and(
					eq(runtimeTargets.runtimeTargetId, target.runtimeTargetId),
					eq(runtimeTargets.runtimeClusterId, input.runtimeClusterId),
				),
			);
		const targets = await transaction.query.runtimeTargets.findMany({
			where: and(
				eq(runtimeTargets.runtimeClusterId, input.runtimeClusterId),
				isNull(runtimeTargets.deletedAt),
			),
			columns: { health: true, lastHeartbeatAt: true },
		});
		const freshnessCutoff = now.getTime() - 45_000;
		const fresh = targets.filter(
			(candidate) =>
				candidate.lastHeartbeatAt &&
				candidate.lastHeartbeatAt.getTime() >= freshnessCutoff,
		);
		const health =
			targets.length > 0 &&
			fresh.length === targets.length &&
			fresh.every((candidate) => candidate.health === "healthy")
				? "healthy"
				: fresh.some((candidate) => candidate.health !== "unavailable")
					? "degraded"
					: "unavailable";
		const latestHeartbeatAt = targets.reduce<Date | null>(
			(latest, candidate) =>
				candidate.lastHeartbeatAt &&
				(!latest || candidate.lastHeartbeatAt > latest)
					? candidate.lastHeartbeatAt
					: latest,
			null,
		);
		const [updated] = await transaction
			.update(runtimeClusters)
			.set({
				controllerVersion: input.controllerVersion,
				health,
				lastHeartbeatAt: latestHeartbeatAt,
				updatedAt: now,
			})
			.where(
				and(
					eq(runtimeClusters.runtimeClusterId, input.runtimeClusterId),
					isNull(runtimeClusters.deletedAt),
				),
			)
			.returning();
		if (!updated) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Runtime cluster not found",
			});
		}
		return updated;
	});
};

export const verifyControllerCertificate = async (input: {
	runtimeClusterId: string;
	serialNumber: string;
	subject: string;
	now?: Date;
}) => {
	const now = input.now ?? new Date();
	const certificate = await db.query.controllerCertificates.findFirst({
		where: and(
			eq(controllerCertificates.runtimeClusterId, input.runtimeClusterId),
			eq(controllerCertificates.serialNumber, input.serialNumber),
			eq(controllerCertificates.subject, input.subject),
			inArray(controllerCertificates.status, ["active", "rotating"]),
			lte(controllerCertificates.notBefore, now),
			gt(controllerCertificates.notAfter, now),
			isNull(controllerCertificates.revokedAt),
		),
		columns: { controllerCertificateId: true },
	});
	return Boolean(certificate);
};
