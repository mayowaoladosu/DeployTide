import { generateKeyPairSync } from "node:crypto";
import {
	acknowledgeControllerJob,
	acquireBuildCapacityLease,
	acquireRuntimeCapacityLease,
	CapacityReconciliationRegistry,
	claimNextFairOperation,
	classifyLegacyInfrastructureInput,
	completeControllerJob,
	enqueueRuntimeControllerJob,
	exportLegacyInfrastructureInput,
	findOperatorServerById,
	findServerById,
	getNextSignedControllerJob,
	heartbeatRuntimeController,
	importApprovedLegacyInfrastructureInput,
	reconcileBuildPoolDrain,
	reconcileExpiredCapacityLeases,
	reconcileExpiredOperationClaims,
	reconcileRuntimeClusterDrain,
	releaseCapacityLease,
	renewCapacityLease,
	requestBuildPoolDrain,
	requestRuntimeClusterDrain,
	restoreBuildPool,
	retireLegacyBootstrapAccess,
	startOperation,
	transitionFencedOperation,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import postgres from "postgres";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { appRouter } from "@/server/api/root";
import {
	createOperatorSessionToken,
	operatorSessionCookieName,
} from "@/server/operator-auth";

const databaseUrl = process.env.PHASE2_INTEGRATION_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const sql = postgres(databaseUrl ?? "postgresql://127.0.0.1:1/disabled", {
	max: 8,
});
const suffix = `${process.pid}_${Date.now()}`;
const fixtureCapability = `phase4.fixture.${suffix}`;
const userA = `phase4_user_a_${suffix}`;
const userB = `phase4_user_b_${suffix}`;
const organizationA = `phase4_org_a_${suffix}`;
const organizationB = `phase4_org_b_${suffix}`;
const providerId = `phase4_provider_${suffix}`;
const regionA = `phase4_region_a_${suffix}`;
const regionB = `phase4_region_b_${suffix}`;
const poolId = `phase4_pool_${suffix}`;
const clusterA = `phase4_cluster_a_${suffix}`;
const clusterB = `phase4_cluster_b_${suffix}`;
const targetA = `phase4_target_a_${suffix}`;
const targetB = `phase4_target_b_${suffix}`;
const projectA = `phase4_project_a_${suffix}`;
const projectB = `phase4_project_b_${suffix}`;
const environmentA = `phase4_environment_a_${suffix}`;
const environmentB = `phase4_environment_b_${suffix}`;
const drainClusterOld = `phase4_drain_cluster_old_${suffix}`;
const drainClusterNew = `phase4_drain_cluster_new_${suffix}`;
const drainTargetOld = `phase4_drain_target_old_${suffix}`;
const drainTargetNew = `phase4_drain_target_new_${suffix}`;

const caller = (input: {
	organizationId: string;
	userId: string;
	email: string;
	headers?: Record<string, string>;
}) =>
	appRouter.createCaller({
		db,
		req: { headers: input.headers ?? {} },
		res: {},
		session: {
			id: `session-${input.userId}`,
			userId: input.userId,
			activeOrganizationId: input.organizationId,
		},
		user: {
			id: input.userId,
			ownerId: input.userId,
			email: input.email,
			role: "owner",
		},
	} as never);

const refreshCapacityHealth = async () => {
	await sql`
		update "infrastructureProvider"
		set health = 'healthy', status = 'ready', "lastHealthAt" = now()
		where "infrastructureProviderId" = ${providerId}
	`;
	await sql`
		update "buildPool"
		set health = 'healthy', "lastHealthAt" = now()
		where "buildPoolId" = ${poolId}
	`;
	await sql`
		update "runtimeCluster"
		set health = 'healthy', "lastHeartbeatAt" = now()
		where "runtimeClusterId" in (${clusterA}, ${clusterB}, ${drainClusterOld}, ${drainClusterNew})
	`;
	await sql`
		update "runtimeTarget"
		set health = 'healthy', "lastHeartbeatAt" = now()
		where "runtimeTargetId" in (${targetA}, ${targetB}, ${drainTargetOld}, ${drainTargetNew})
	`;
};

const operation = async (
	organizationId: string,
	key: string,
	leaseOwner: string,
) => {
	await refreshCapacityHealth();
	const kind = `phase4-capacity-${key}-${suffix}`;
	const started = await startOperation({
		organizationId,
		idempotencyKey: `${key}-${suffix}`,
		kind,
		actorType: "operator",
		resourceType: "capacity",
		resourceId: key,
	});
	const claimed = await claimNextFairOperation({
		kind,
		leaseOwner,
		ttlMs: 15 * 60_000,
	});
	if (
		!claimed ||
		(claimed as { operationId?: string }).operationId !== started.operationId
	) {
		throw new Error("Fixture operation was not claimed");
	}
	return claimed as typeof started & {
		leaseOwner: string;
		leaseExpiresAt: Date;
		fencingToken: number;
	};
};

const seedRelease = async (input: {
	prefix: string;
	organizationId: string;
	projectId: string;
	environmentId: string;
	operationId?: string;
	buildOperationId?: string;
	status?: "queued" | "ready" | "failed";
	runtimeTargetId?: string;
	runtimePlacementId?: string;
}) => {
	await sql`
		insert into "configurationSnapshot" (
			"configurationSnapshotId", "organizationId", "projectId", "environmentId",
			"serviceType", "serviceId", "sourceConfig", "buildConfig", "runtimeConfig",
			"contentDigest"
		) values (
			${`${input.prefix}_config`}, ${input.organizationId}, ${input.projectId},
			${input.environmentId}, 'test', ${input.prefix}, '{}'::jsonb, '{}'::jsonb,
			'{}'::jsonb, ${`sha256:${input.prefix}`}
		)
	`;
	await sql`
		insert into deployment (
			"deploymentId", "organizationId", "projectId", "environmentId",
			"configurationSnapshotId", title, status, trigger, "logPath", "createdAt",
			"desiredSequence"
		) values (
			${`${input.prefix}_deployment`}, ${input.organizationId}, ${input.projectId},
			${input.environmentId}, ${`${input.prefix}_config`}, ${input.prefix}, 'ready',
			'manual', ${`/logs/${input.prefix}.log`}, now()::text, 1
		)
	`;
	await sql`
		insert into build (
			"buildId", "organizationId", "projectId", "deploymentId", "operationId", status,
			"buildPlan", "sourceSnapshot"
		) values (
			${`${input.prefix}_build`}, ${input.organizationId}, ${input.projectId},
			${`${input.prefix}_deployment`}, ${input.buildOperationId ?? null}, 'succeeded',
			'{}'::jsonb, '{}'::jsonb
		)
	`;
	await sql`
		insert into artifact (
			"artifactId", "organizationId", "projectId", "buildId", type, status, digest
		) values (
			${`${input.prefix}_artifact`}, ${input.organizationId}, ${input.projectId},
			${`${input.prefix}_build`}, 'oci', 'available',
			${`sha256:${input.prefix.padEnd(64, "0").slice(0, 64)}`}
		)
	`;
	await sql`
		insert into release (
			"releaseId", "organizationId", "projectId", "environmentId", "deploymentId",
			"artifactId", "operationId", status, "runtimeConfigVersion", "serviceIdentity",
			"runtimeTargetId", "runtimePlacementId"
		) values (
			${`${input.prefix}_release`}, ${input.organizationId}, ${input.projectId},
			${input.environmentId}, ${`${input.prefix}_deployment`}, ${`${input.prefix}_artifact`},
			${input.operationId ?? null}, ${input.status ?? "ready"}, 'v1',
			${`service-${input.prefix}`}, ${input.runtimeTargetId ?? null},
			${input.runtimePlacementId ?? null}
		)
	`;
	return `${input.prefix}_release`;
};

describeDatabase("Phase 4 operator infrastructure", () => {
	beforeAll(async () => {
		await sql`
			insert into "user" (id, "expirationDate", "createdAt", email, email_verified, updated_at)
			values
				(${userA}, '2099-01-01', '2026-01-01', ${`phase4-a-${suffix}@deploytide.local`}, true, now()),
				(${userB}, '2099-01-01', '2026-01-01', ${`phase4-b-${suffix}@deploytide.local`}, true, now())
		`;
		await sql`
			insert into organization (id, name, slug, created_at, owner_id)
			values
				(${organizationA}, 'Phase 4 A', ${`phase4-a-${suffix}`}, now(), ${userA}),
				(${organizationB}, 'Phase 4 B', ${`phase4-b-${suffix}`}, now(), ${userB})
		`;
		await sql`
			insert into member (id, organization_id, user_id, role, created_at)
			values
				(${`phase4_member_a_${suffix}`}, ${organizationA}, ${userA}, 'owner', now()),
				(${`phase4_member_b_${suffix}`}, ${organizationB}, ${userB}, 'owner', now())
		`;
		await sql`
			insert into project ("projectId", name, slug, "createdAt", "organizationId")
			values
				(${projectA}, 'Phase 4 Project A', ${`phase4-project-a-${suffix}`}, '2026-01-01', ${organizationA}),
				(${projectB}, 'Phase 4 Project B', ${`phase4-project-b-${suffix}`}, '2026-01-01', ${organizationB})
		`;
		await sql`
			insert into environment (
				"environmentId", name, "createdAt", "projectId", "organizationId",
				"isDefault", kind
			) values
				(${environmentA}, 'Production', '2026-01-01', ${projectA}, ${organizationA}, true, 'production'),
				(${environmentB}, 'Production', '2026-01-01', ${projectB}, ${organizationB}, true, 'production')
		`;
		await sql`
			insert into "infrastructureProvider" (
				"infrastructureProviderId", name, "adapterType", "endpointReference",
				"enabledRegionCodes", capabilities, health, status, version, "lastHealthAt"
			) values (
				${providerId}, ${`Phase 4 Provider ${suffix}`}, 'contract-test', 'internal://contract-test',
				array['phase4-a','phase4-b'], ${JSON.stringify(["build.rootless", "runtime.container", fixtureCapability])}::jsonb,
				'healthy', 'ready', '1.0.0', now()
			)
		`;
		await sql`
			insert into region (
				"regionId", "infrastructureProviderId", code, name, "providerRegionReference",
				"buildAvailable", "runtimeAvailable", status, "routingWeight", "costWeight"
			) values
				(${regionA}, ${providerId}, ${`phase4-a-${suffix}`}, 'Phase 4 A', 'provider-a', true, true, 'ready', 110, 100),
				(${regionB}, ${providerId}, ${`phase4-b-${suffix}`}, 'Phase 4 B', 'provider-b', false, true, 'ready', 100, 100)
		`;
		await sql`
			insert into "buildPool" (
				"buildPoolId", "infrastructureProviderId", "regionId", name, "adapterType",
				architecture, "workerClass", rootless, "minCapacity", "maxCapacity",
				"totalCapacity", "reservedCapacity", "cacheNamespace", health, "drainState", version,
				"lastHealthAt"
			) values (
				${poolId}, ${providerId}, ${regionA}, 'Phase 4 Rootless', 'rootless-buildkit',
				'amd64', 'test', true, 0, 1, 1, 0, ${`phase4-${suffix}`}, 'healthy', 'active', '0.25.1', now()
			)
		`;
		await sql`
			insert into "runtimeCluster" (
				"runtimeClusterId", "infrastructureProviderId", "regionId", name, "runtimeAdapter",
				"endpointReference", "certificateReference", "controllerIdentity", "totalCpuMillis",
				"reservedCpuMillis", "totalMemoryMb", "reservedMemoryMb", health, "drainState",
				"controllerVersion", version, "lastHeartbeatAt"
			) values
				(${clusterA}, ${providerId}, ${regionA}, 'Runtime A', 'contract-runtime', 'internal://a', 'file://a', ${`controller:${suffix}:a`}, 1000, 0, 1024, 0, 'healthy', 'active', '1.0.0', '1.0.0', now()),
				(${clusterB}, ${providerId}, ${regionB}, 'Runtime B', 'contract-runtime', 'internal://b', 'file://b', ${`controller:${suffix}:b`}, 1000, 0, 1024, 0, 'healthy', 'active', '1.0.0', '1.0.0', now()),
				(${drainClusterOld}, ${providerId}, ${regionA}, 'Drain Runtime Old', 'contract-runtime', 'internal://drain-old', 'file://drain-old', ${`controller:${suffix}:drain-old`}, 1000, 0, 1024, 0, 'healthy', 'active', '1.0.0', '1.0.0', now()),
				(${drainClusterNew}, ${providerId}, ${regionB}, 'Drain Runtime New', 'contract-runtime', 'internal://drain-new', 'file://drain-new', ${`controller:${suffix}:drain-new`}, 1000, 0, 1024, 0, 'healthy', 'active', '1.0.0', '1.0.0', now())
		`;
		await sql`
			insert into "runtimeTarget" (
				"runtimeTargetId", "runtimeClusterId", "providerTargetReference", architecture,
				"totalCpuMillis", "reservedCpuMillis", "totalMemoryMb", "reservedMemoryMb",
				health, "drainState", "placementLabels", "lastHeartbeatAt", version
			) values
				(${targetA}, ${clusterA}, 'target-a', 'amd64', 1000, 0, 1024, 0, 'healthy', 'active', '{"residency":"a"}'::jsonb, now(), '1.0.0'),
				(${targetB}, ${clusterB}, 'target-b', 'amd64', 1000, 0, 1024, 0, 'healthy', 'active', '{"residency":"b"}'::jsonb, now(), '1.0.0'),
				(${drainTargetOld}, ${drainClusterOld}, 'drain-target-old', 'amd64', 1000, 0, 1024, 0, 'healthy', 'active', '{"residency":"drain-a"}'::jsonb, now(), '1.0.0'),
				(${drainTargetNew}, ${drainClusterNew}, 'drain-target-new', 'amd64', 1000, 0, 1024, 0, 'healthy', 'active', '{"residency":"drain-b"}'::jsonb, now(), '1.0.0')
		`;
	});

	it("keeps the global operator router outside customer and operator-token audiences", async () => {
		await expect(
			caller({
				organizationId: organizationA,
				userId: userA,
				email: `phase4-a-${suffix}@deploytide.local`,
			}).infrastructure.overview(),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		vi.stubEnv("DEPLOYTIDE_OPERATOR_API_TOKEN", "operator-api-token");
		await expect(
			caller({
				organizationId: organizationA,
				userId: userA,
				email: `phase4-a-${suffix}@deploytide.local`,
				headers: { "x-deploytide-operator-token": "operator-api-token" },
			}).infrastructure.overview(),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		vi.unstubAllEnvs();
	});

	it("allows only a configured superadmin with the separate browser audience", async () => {
		const email = `phase4-a-${suffix}@deploytide.local`;
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SESSION_SECRET",
			"phase4-operator-session-secret-at-least-32-bytes",
		);
		vi.stubEnv("DEPLOYTIDE_SUPERADMIN_EMAILS", email);
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_ORIGIN",
			"https://operator.deploytide.test",
		);
		const req = { headers: { "user-agent": "phase4-integration" } } as never;
		const token = createOperatorSessionToken({ userId: userA, email, req });
		const overview = await caller({
			organizationId: organizationA,
			userId: userA,
			email,
			headers: {
				cookie: `${operatorSessionCookieName}=${encodeURIComponent(token)}`,
				"user-agent": "phase4-integration",
				origin: "https://operator.deploytide.test",
				"sec-fetch-site": "same-origin",
			},
		}).infrastructure.overview();
		expect(
			overview.providers.some(
				(provider) => provider.infrastructureProviderId === providerId,
			),
		).toBe(true);
		const serialized = JSON.stringify(overview);
		for (const forbidden of [
			"secretReference",
			"endpointReference",
			"providerRegionReference",
			"providerTargetReference",
			"certificateReference",
			"certificatePem",
			"privateKeyReference",
			"caFingerprint",
			"exportPayload",
			"redactedDiagnostics",
			'"request":',
			'"progress":',
			'"result":',
			'"signature":',
			targetA,
			targetB,
		]) {
			expect(serialized).not.toContain(forbidden);
		}
		vi.unstubAllEnvs();
	});

	it("audits provider lifecycle without secret or endpoint metadata", async () => {
		const email = `phase4-a-${suffix}@deploytide.local`;
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SESSION_SECRET",
			"phase4-operator-session-secret-at-least-32-bytes",
		);
		vi.stubEnv("DEPLOYTIDE_SUPERADMIN_EMAILS", email);
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_ORIGIN",
			"https://operator.deploytide.test",
		);
		vi.stubEnv("PHASE4_AUDIT_PROVIDER_TOKEN", "audit-provider-private-token");
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SECRET_REFERENCES",
			JSON.stringify({
				"audit-provider-secret": "env://PHASE4_AUDIT_PROVIDER_TOKEN",
			}),
		);
		const req = { headers: { "user-agent": "phase4-audit" } } as never;
		const token = createOperatorSessionToken({ userId: userA, email, req });
		const csrf = (
			JSON.parse(
				Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
			) as { csrf: string }
		).csrf;
		const operator = caller({
			organizationId: organizationA,
			userId: userA,
			email,
			headers: {
				cookie: `${operatorSessionCookieName}=${encodeURIComponent(token)}`,
				"user-agent": "phase4-audit",
				origin: "https://operator.deploytide.test",
				"sec-fetch-site": "same-origin",
				"content-type": "application/json",
				"x-deploytide-operator-csrf": csrf,
			},
		});
		const created = await operator.infrastructure.createProvider({
			name: `Audit Provider ${suffix}`,
			adapterType: "layerrail-compute",
			endpointReference: `https://compute-${suffix}.deploytide.test`,
			secretId: "audit-provider-secret",
			capabilities: ["runtime.container"],
			version: "1.0.0",
		});
		expect(JSON.stringify(created)).not.toContain("endpointReference");
		expect(JSON.stringify(created)).not.toContain("secretReference");
		const [audit] = await sql<
			[
				{
					action: string;
					resourceType: string;
					metadata: Record<string, unknown> | null;
				},
			]
		>`
			select action, "resourceType", metadata
			from "operatorAuditLog"
			where "resourceId" = ${created.infrastructureProviderId}
			order by "createdAt" desc
			limit 1
		`;
		expect(audit).toMatchObject({
			action: "create",
			resourceType: "infrastructureProvider",
			metadata: { adapterType: "layerrail-compute" },
		});
		expect(JSON.stringify(audit)).not.toMatch(
			/secret|token|private.?key|credential|endpoint/i,
		);
		vi.unstubAllEnvs();
	});

	it("prevents concurrent schedulers from over-reserving build capacity", async () => {
		const firstOperation = await operation(
			organizationA,
			"build-one",
			"scheduler-a",
		);
		const secondOperation = await operation(
			organizationB,
			"build-two",
			"scheduler-b",
		);
		const results = await Promise.allSettled([
			acquireBuildCapacityLease({
				leaseScope: "operator",
				organizationId: organizationA,
				operationId: firstOperation.operationId,
				operationFencingToken: firstOperation.fencingToken,
				leaseOwner: "scheduler-a",
				ttlMs: 5 * 60_000,
				capacity: 1,
				policy: {
					architecture: "amd64",
					requiredCapabilities: ["build.rootless", fixtureCapability],
				},
			}),
			acquireBuildCapacityLease({
				leaseScope: "operator",
				organizationId: organizationB,
				operationId: secondOperation.operationId,
				operationFencingToken: secondOperation.fencingToken,
				leaseOwner: "scheduler-b",
				ttlMs: 5 * 60_000,
				capacity: 1,
				policy: {
					architecture: "amd64",
					requiredCapabilities: ["build.rootless", fixtureCapability],
				},
			}),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		const winner = results.find((result) => result.status === "fulfilled");
		if (!winner || winner.status !== "fulfilled")
			throw new Error("No build lease winner");
		await releaseCapacityLease({
			capacityLeaseId: winner.value.capacityLeaseId,
			leaseOwner: winner.value.leaseOwner,
			fencingToken: winner.value.fencingToken,
		});
		const [pool] = await sql<
			[{ reserved: number }]
		>`select "reservedCapacity"::int as reserved from "buildPool" where "buildPoolId" = ${poolId}`;
		expect(pool?.reserved).toBe(0);
	});

	it("runs the complete build-pool drain lifecycle without corrupting concurrent state", async () => {
		const leaseOwner = "build-pool-drain-owner";
		const claimed = await operation(
			organizationA,
			"build-pool-drain",
			leaseOwner,
		);
		let lease: Awaited<ReturnType<typeof acquireBuildCapacityLease>> | null =
			null;
		let leaseReleased = false;
		try {
			lease = await acquireBuildCapacityLease({
				leaseScope: "operator",
				organizationId: organizationA,
				operationId: claimed.operationId,
				operationFencingToken: claimed.fencingToken,
				leaseOwner,
				ttlMs: 5 * 60_000,
				capacity: 1,
				policy: {
					architecture: "amd64",
					requiredCapabilities: ["build.rootless", fixtureCapability],
				},
			});
			const audit = {
				actorUserId: userA,
				actorEmail: `phase4-a-${suffix}@deploytide.local`,
				action: "drain",
				resourceType: "buildPool",
			};

			await expect(
				requestBuildPoolDrain(poolId, {
					...audit,
					metadata: { secretReference: "must-not-commit" },
				}),
			).rejects.toThrow(/not safe/i);
			const [rolledBack] = await sql<[{ drainState: string; audits: number }]>`
				select "drainState"::text as "drainState",
					(select count(*)::int from "operatorAuditLog"
						where "resourceId" = ${poolId} and action = 'drain') as audits
				from "buildPool" where "buildPoolId" = ${poolId}
			`;
			expect(rolledBack).toEqual({ drainState: "active", audits: 0 });

			const requested = await Promise.all([
				requestBuildPoolDrain(poolId, audit),
				requestBuildPoolDrain(poolId, audit),
			]);
			expect(requested).toEqual([
				{ buildPoolId: poolId, drainState: "draining" },
				{ buildPoolId: poolId, drainState: "draining" },
			]);
			const [drainAudit] = await sql<[{ count: number }]>`
				select count(*)::int as count from "operatorAuditLog"
				where "resourceId" = ${poolId} and action = 'drain'
			`;
			expect(drainAudit?.count).toBe(1);

			await expect(reconcileBuildPoolDrain(poolId)).resolves.toEqual({
				buildPoolId: poolId,
				drainState: "draining",
				complete: false,
				activeLeaseCount: 1,
			});

			await releaseCapacityLease({
				capacityLeaseId: lease.capacityLeaseId,
				leaseOwner: lease.leaseOwner,
				fencingToken: lease.fencingToken,
			});
			leaseReleased = true;

			const blockedOwner = "build-pool-drain-blocked-owner";
			const blockedOperation = await operation(
				organizationB,
				"build-pool-drain-blocked",
				blockedOwner,
			);
			await expect(
				acquireBuildCapacityLease({
					leaseScope: "operator",
					organizationId: organizationB,
					operationId: blockedOperation.operationId,
					operationFencingToken: blockedOperation.fencingToken,
					leaseOwner: blockedOwner,
					ttlMs: 5 * 60_000,
					capacity: 1,
					policy: {
						architecture: "amd64",
						requiredCapabilities: ["build.rootless", fixtureCapability],
					},
				}),
			).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
			await transitionFencedOperation({
				organizationId: organizationB,
				operationId: blockedOperation.operationId,
				expectedStatus: "running",
				nextStatus: "succeeded",
				leaseOwner: blockedOwner,
				fencingToken: blockedOperation.fencingToken,
			});

			const reconciled = await Promise.all([
				reconcileBuildPoolDrain(poolId, {
					...audit,
					action: "reconcile",
				}),
				reconcileBuildPoolDrain(poolId, {
					...audit,
					action: "reconcile",
				}),
			]);
			expect(reconciled).toEqual([
				{
					buildPoolId: poolId,
					drainState: "drained",
					complete: true,
					activeLeaseCount: 0,
				},
				{
					buildPoolId: poolId,
					drainState: "drained",
					complete: true,
					activeLeaseCount: 0,
				},
			]);
			await expect(requestBuildPoolDrain(poolId, audit)).resolves.toEqual({
				buildPoolId: poolId,
				drainState: "drained",
			});

			const restored = await Promise.all([
				restoreBuildPool(poolId, { ...audit, action: "restore" }),
				restoreBuildPool(poolId, { ...audit, action: "restore" }),
			]);
			expect(restored).toEqual([
				{ buildPoolId: poolId, drainState: "active" },
				{ buildPoolId: poolId, drainState: "active" },
			]);
			const lifecycleAudits = await sql<{ action: string; count: number }[]>`
				select action, count(*)::int as count
				from "operatorAuditLog"
				where "resourceId" = ${poolId}
				group by action
			`;
			expect(
				Object.fromEntries(
					lifecycleAudits.map((row) => [row.action, row.count]),
				),
			).toMatchObject({
				drain: 1,
				reconcile: 1,
				restore: 1,
			});
			const [pool] = await sql<
				[{ drainState: string; reservedCapacity: number }]
			>`
				select "drainState"::text as "drainState",
					"reservedCapacity"::int as "reservedCapacity"
				from "buildPool" where "buildPoolId" = ${poolId}
			`;
			expect(pool).toEqual({
				drainState: "active",
				reservedCapacity: 0,
			});
		} finally {
			if (lease && !leaseReleased) {
				await releaseCapacityLease({
					capacityLeaseId: lease.capacityLeaseId,
					leaseOwner: lease.leaseOwner,
					fencingToken: lease.fencingToken,
				}).catch(() => undefined);
				await sql`
					update "capacityLease"
					set state = 'released', "releasedAt" = now(), "updatedAt" = now()
					where "capacityLeaseId" = ${lease.capacityLeaseId}
						and state in ('active', 'releasing', 'reconciling')
				`;
			}
			await sql`
				update "buildPool" pool
				set "drainState" = 'active',
					"reservedCapacity" = coalesce((
						select sum(lease."reservedCapacity")::int
						from "capacityLease" lease
						where lease."buildPoolId" = pool."buildPoolId"
							and lease.state in ('active', 'releasing', 'reconciling')
					), 0),
					"updatedAt" = now()
				where pool."buildPoolId" = ${poolId}
			`;
		}
	});

	it("rejects cross-tenant resources and wrong-kind lease tuples", async () => {
		const ownerA = "ownership-a";
		const ownerB = "ownership-b";
		const operationA = await operation(organizationA, ownerA, ownerA);
		const operationB = await operation(organizationB, ownerB, ownerB);
		const releaseA = await seedRelease({
			prefix: `phase4_ownership_a_${suffix}`,
			organizationId: organizationA,
			projectId: projectA,
			environmentId: environmentA,
			operationId: operationA.operationId,
		});
		const releaseB = await seedRelease({
			prefix: `phase4_ownership_b_${suffix}`,
			organizationId: organizationB,
			projectId: projectB,
			environmentId: environmentB,
			operationId: operationB.operationId,
		});
		await expect(
			acquireRuntimeCapacityLease({
				leaseScope: "workspace",
				organizationId: organizationB,
				operationId: operationA.operationId,
				operationFencingToken: operationA.fencingToken,
				releaseId: releaseA,
				leaseOwner: ownerA,
				ttlMs: 5 * 60_000,
				cpuMillis: 100,
				memoryMb: 64,
				policy: { architecture: "amd64" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			acquireRuntimeCapacityLease({
				leaseScope: "workspace",
				organizationId: organizationA,
				operationId: operationA.operationId,
				operationFencingToken: operationA.fencingToken,
				releaseId: releaseB,
				leaseOwner: ownerA,
				ttlMs: 5 * 60_000,
				cpuMillis: 100,
				memoryMb: 64,
				policy: { architecture: "amd64" },
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

		await expect(
			sql`
				insert into "capacityLease" (
					"capacityLeaseId", "organizationId", "operationId", kind, "leaseScope",
					"runtimeClusterId", "runtimeTargetId", "reservedCapacity",
					"reservedCpuMillis", "reservedMemoryMb", "leaseOwner", "expiresAt"
				) values (
					${`phase4_wrong_kind_${suffix}`}, ${organizationA}, ${operationA.operationId},
					'build', 'operator', ${clusterA}, ${targetA}, 1, 1, 1, 'wrong-kind',
					now() + interval '5 minutes'
				)
			`,
		).rejects.toMatchObject({ code: "23514" });
	});

	it("places runtime leases across two regions and reconciles worker loss", async () => {
		const firstOperation = await operation(
			organizationA,
			"runtime-one",
			"runtime-a",
		);
		const secondOperation = await operation(
			organizationB,
			"runtime-two",
			"runtime-b",
		);
		const first = await acquireRuntimeCapacityLease({
			leaseScope: "operator",
			organizationId: organizationA,
			operationId: firstOperation.operationId,
			operationFencingToken: firstOperation.fencingToken,
			leaseOwner: "runtime-a",
			ttlMs: 5 * 60_000,
			cpuMillis: 800,
			memoryMb: 128,
			policy: {
				architecture: "amd64",
				requiredCapabilities: ["runtime.container", fixtureCapability],
			},
		});
		const second = await acquireRuntimeCapacityLease({
			leaseScope: "operator",
			organizationId: organizationB,
			operationId: secondOperation.operationId,
			operationFencingToken: secondOperation.fencingToken,
			leaseOwner: "runtime-b",
			ttlMs: 5 * 60_000,
			cpuMillis: 800,
			memoryMb: 128,
			policy: {
				architecture: "amd64",
				requiredCapabilities: ["runtime.container", fixtureCapability],
			},
		});
		expect(first.runtimeClusterId).not.toBe(second.runtimeClusterId);
		await sql`update "capacityLease" set "expiresAt" = now() - interval '1 second' where "capacityLeaseId" in (${first.capacityLeaseId}, ${second.capacityLeaseId})`;
		const registry = new CapacityReconciliationRegistry().registerRuntime(
			async () => ({
				status: "clean",
				proofId: "runtime-placement-absent",
				placementDrained: true,
			}),
		);
		const reconciliation = await reconcileExpiredCapacityLeases({ registry });
		expect(reconciliation.recovered).toEqual(
			expect.arrayContaining([first.capacityLeaseId, second.capacityLeaseId]),
		);
		const clusters = await sql<{ reserved: number }[]>`
			select "reservedCpuMillis"::int as reserved from "runtimeCluster"
			where "runtimeClusterId" in (${clusterA}, ${clusterB}) order by "runtimeClusterId"
		`;
		expect(clusters.map((cluster) => cluster.reserved)).toEqual([0, 0]);
	});

	it("requires fresh architecture-compatible affinity evidence", async () => {
		const staleOwner = "stale-affinity-owner";
		const staleOperation = await operation(
			organizationB,
			"stale-affinity",
			staleOwner,
		);
		await sql`update "runtimeTarget" set "lastHeartbeatAt" = now() - interval '10 minutes' where "runtimeTargetId" = ${targetB}`;
		await expect(
			acquireRuntimeCapacityLease({
				leaseScope: "operator",
				organizationId: organizationB,
				operationId: staleOperation.operationId,
				operationFencingToken: staleOperation.fencingToken,
				leaseOwner: staleOwner,
				ttlMs: 5 * 60_000,
				cpuMillis: 100,
				memoryMb: 64,
				policy: {
					architecture: "amd64",
					dataAffinity: { residency: "b" },
				},
			}),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
		await refreshCapacityHealth();
		const affinityLease = await acquireRuntimeCapacityLease({
			leaseScope: "operator",
			organizationId: organizationB,
			operationId: staleOperation.operationId,
			operationFencingToken: staleOperation.fencingToken,
			leaseOwner: staleOwner,
			ttlMs: 5 * 60_000,
			cpuMillis: 100,
			memoryMb: 64,
			policy: {
				architecture: "amd64",
				dataAffinity: { residency: "b" },
			},
		});
		expect(affinityLease.runtimeTargetId).toBe(targetB);
		await releaseCapacityLease({
			capacityLeaseId: affinityLease.capacityLeaseId,
			leaseOwner: affinityLease.leaseOwner,
			fencingToken: affinityLease.fencingToken,
		});

		const armOwner = "arm-owner";
		const armOperation = await operation(organizationB, "arm", armOwner);
		await expect(
			acquireRuntimeCapacityLease({
				leaseScope: "operator",
				organizationId: organizationB,
				operationId: armOperation.operationId,
				operationFencingToken: armOperation.fencingToken,
				leaseOwner: armOwner,
				ttlMs: 5 * 60_000,
				cpuMillis: 100,
				memoryMb: 64,
				policy: { architecture: "arm64" },
			}),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
	});

	it("retains counters after failed cleanup and releases only after zero-residue proof", async () => {
		const leaseOwner = "cleanup-build-owner";
		const claimed = await operation(organizationA, "cleanup-build", leaseOwner);
		const lease = await acquireBuildCapacityLease({
			leaseScope: "operator",
			organizationId: organizationA,
			operationId: claimed.operationId,
			operationFencingToken: claimed.fencingToken,
			leaseOwner,
			ttlMs: 5 * 60_000,
			capacity: 1,
			policy: { architecture: "amd64" },
		});
		await sql`update "capacityLease" set "expiresAt" = now() - interval '1 second' where "capacityLeaseId" = ${lease.capacityLeaseId}`;
		const failing = new CapacityReconciliationRegistry().registerBuild(
			async () => {
				throw new Error("lease-labeled worker is still running");
			},
		);
		const failed = await reconcileExpiredCapacityLeases({
			registry: failing,
			limit: 1,
		});
		expect(failed.failed).toEqual([lease.capacityLeaseId]);
		const [stillReserved] = await sql<
			[{ reserved: number; state: string }]
		>`select "reservedCapacity"::int as reserved,
				(select state::text from "capacityLease" where "capacityLeaseId" = ${lease.capacityLeaseId}) as state
			from "buildPool" where "buildPoolId" = ${poolId}`;
		expect(stillReserved).toEqual({ reserved: 1, state: "reconciling" });

		const successful = new CapacityReconciliationRegistry().registerBuild(
			async () => ({
				status: "clean",
				proofId: "docker-label-scan-empty",
				residue: { workers: 0, containers: 0, networks: 0, volumes: 0 },
			}),
		);
		const recovered = await reconcileExpiredCapacityLeases({
			registry: successful,
			limit: 1,
		});
		expect(recovered.recovered).toEqual([lease.capacityLeaseId]);
		const [released] = await sql<
			[{ reserved: number; state: string }]
		>`select "reservedCapacity"::int as reserved,
				(select state::text from "capacityLease" where "capacityLeaseId" = ${lease.capacityLeaseId}) as state
			from "buildPool" where "buildPoolId" = ${poolId}`;
		expect(released).toEqual({ reserved: 0, state: "expired" });
	});

	it("renews and transitions only unexpired exact fencing claims", async () => {
		const leaseOwner = "renew-owner";
		const claimed = await operation(organizationA, "renew", leaseOwner);
		const lease = await acquireBuildCapacityLease({
			leaseScope: "operator",
			organizationId: organizationA,
			operationId: claimed.operationId,
			operationFencingToken: claimed.fencingToken,
			leaseOwner,
			ttlMs: 5 * 60_000,
			capacity: 1,
			policy: { architecture: "amd64" },
		});
		await expect(
			renewCapacityLease({
				capacityLeaseId: lease.capacityLeaseId,
				leaseOwner,
				fencingToken: lease.fencingToken,
				ttlMs: 5 * 60_000,
			}),
		).resolves.toMatchObject({ capacityLeaseId: lease.capacityLeaseId });
		await expect(
			transitionFencedOperation({
				organizationId: organizationA,
				operationId: claimed.operationId,
				capacityLeaseId: lease.capacityLeaseId,
				capacityFencingToken: lease.fencingToken,
				expectedStatus: "running",
				nextStatus: "succeeded",
				leaseOwner,
				fencingToken: claimed.fencingToken + 1,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await sql`update "capacityLease" set "expiresAt" = now() - interval '1 second' where "capacityLeaseId" = ${lease.capacityLeaseId}`;
		await expect(
			renewCapacityLease({
				capacityLeaseId: lease.capacityLeaseId,
				leaseOwner,
				fencingToken: lease.fencingToken,
				ttlMs: 5 * 60_000,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await reconcileExpiredCapacityLeases({
			limit: 1,
			registry: new CapacityReconciliationRegistry().registerBuild(
				async () => ({
					status: "clean",
					proofId: "renew-clean",
					residue: { workers: 0, containers: 0, networks: 0, volumes: 0 },
				}),
			),
		});
		await expect(
			transitionFencedOperation({
				organizationId: organizationA,
				operationId: claimed.operationId,
				capacityLeaseId: lease.capacityLeaseId,
				capacityFencingToken: lease.fencingToken,
				expectedStatus: "running",
				nextStatus: "succeeded",
				leaseOwner,
				fencingToken: claimed.fencingToken,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		const noCapacity = await operation(
			organizationA,
			"no-capacity-completion",
			"no-capacity-worker",
		);
		await expect(
			transitionFencedOperation({
				organizationId: organizationA,
				operationId: noCapacity.operationId,
				expectedStatus: "running",
				nextStatus: "succeeded",
				leaseOwner: "no-capacity-worker",
				fencingToken: noCapacity.fencingToken,
			}),
		).resolves.toMatchObject({ status: "succeeded" });

		const stale = await operation(
			organizationA,
			"stale-operation",
			"stale-worker",
		);
		await sql`update operation set "leaseExpiresAt" = now() - interval '1 second' where "operationId" = ${stale.operationId}`;
		await expect(
			transitionFencedOperation({
				organizationId: organizationA,
				operationId: stale.operationId,
				expectedStatus: "running",
				nextStatus: "succeeded",
				leaseOwner: "stale-worker",
				fencingToken: stale.fencingToken,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("requeues no more than the configured expired-operation limit", async () => {
		const ids: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			const claimed = await operation(
				organizationB,
				`bounded-${index}`,
				`bounded-owner-${index}`,
			);
			ids.push(claimed.operationId);
		}
		await sql`update operation set "leaseExpiresAt" = now() - interval '1 hour' where "operationId" in ${sql(ids)}`;
		expect(await reconcileExpiredOperationClaims(2)).toBe(2);
		const [states] = await sql<
			[{ pending: number; running: number }]
		>`select count(*) filter (where status = 'pending')::int as pending,
				count(*) filter (where status = 'running')::int as running
			from operation where "operationId" in ${sql(ids)}`;
		expect(states).toEqual({ pending: 2, running: 1 });
	});

	it("redelivers acknowledged work and creates one new sequence for retryable failure", async () => {
		const controllerOperation = await operation(
			organizationA,
			"controller-retry",
			"controller-retry-owner",
		);
		const lease = await acquireRuntimeCapacityLease({
			leaseScope: "operator",
			organizationId: organizationA,
			operationId: controllerOperation.operationId,
			operationFencingToken: controllerOperation.fencingToken,
			leaseOwner: "controller-retry-owner",
			ttlMs: 5 * 60_000,
			cpuMillis: 100,
			memoryMb: 64,
			policy: {
				architecture: "amd64",
				requiredCapabilities: ["runtime.container", fixtureCapability],
			},
		});
		if (!lease.runtimeClusterId || !lease.runtimeTargetId)
			throw new Error("Runtime lease has no cluster or target");
		const attempt = await enqueueRuntimeControllerJob({
			operationId: controllerOperation.operationId,
			capacityLeaseId: lease.capacityLeaseId,
			runtimeClusterId: lease.runtimeClusterId,
			kind: "cluster_health",
			request: {},
		});
		const { privateKey } = generateKeyPairSync("ed25519", {
			privateKeyEncoding: { format: "pem", type: "pkcs8" },
			publicKeyEncoding: { format: "pem", type: "spki" },
		});
		const first = await getNextSignedControllerJob({
			runtimeClusterId: lease.runtimeClusterId,
			runtimeTargetId: lease.runtimeTargetId,
			afterSequence: 0,
			privateKeyPem: privateKey,
		});
		expect(first?.attemptId).toBe(attempt.operatorJobAttemptId);
		expect(first?.resourceKey).toBe(`cluster:${lease.runtimeClusterId}`);
		expect(typeof first?.payload).toBe("string");
		await acknowledgeControllerJob({
			operatorJobAttemptId: attempt.operatorJobAttemptId,
			runtimeClusterId: lease.runtimeClusterId,
			runtimeTargetId: lease.runtimeTargetId,
			fencingToken: lease.fencingToken,
		});
		await expect(
			acknowledgeControllerJob({
				operatorJobAttemptId: attempt.operatorJobAttemptId,
				runtimeClusterId: lease.runtimeClusterId,
				runtimeTargetId: lease.runtimeTargetId,
				fencingToken: lease.fencingToken,
			}),
		).resolves.toMatchObject({
			operatorJobAttemptId: attempt.operatorJobAttemptId,
		});
		const redelivered = await getNextSignedControllerJob({
			runtimeClusterId: lease.runtimeClusterId,
			runtimeTargetId: lease.runtimeTargetId,
			afterSequence: 0,
			privateKeyPem: privateKey,
		});
		expect(redelivered?.attemptId).toBe(attempt.operatorJobAttemptId);
		await completeControllerJob({
			operatorJobAttemptId: attempt.operatorJobAttemptId,
			runtimeClusterId: lease.runtimeClusterId,
			runtimeTargetId: lease.runtimeTargetId,
			fencingToken: lease.fencingToken,
			succeeded: false,
			retryable: true,
			diagnostics: "engine temporarily unavailable",
		});
		await expect(
			completeControllerJob({
				operatorJobAttemptId: attempt.operatorJobAttemptId,
				runtimeClusterId: lease.runtimeClusterId,
				runtimeTargetId: lease.runtimeTargetId,
				fencingToken: lease.fencingToken,
				succeeded: false,
				retryable: true,
				diagnostics: "engine temporarily unavailable",
			}),
		).resolves.toMatchObject({
			operatorJobAttemptId: attempt.operatorJobAttemptId,
		});
		const attempts = await sql<
			{ id: string; sequence: number; status: string }[]
		>`
			select "operatorJobAttemptId" as id, sequence::int, status::text
			from "operatorJobAttempt"
			where "operationId" = ${controllerOperation.operationId}
			order by sequence
		`;
		expect(attempts).toHaveLength(2);
		expect(attempts.map((entry) => entry.status)).toEqual(["failed", "queued"]);
		expect(attempts[1]?.sequence).toBeGreaterThan(attempts[0]?.sequence ?? 0);
		await releaseCapacityLease({
			capacityLeaseId: lease.capacityLeaseId,
			leaseOwner: lease.leaseOwner,
			fencingToken: lease.fencingToken,
		});
	});

	it("fences stale controller completion after lease expiry", async () => {
		const leaseOwner = "stale-controller-owner";
		const controllerOperation = await operation(
			organizationA,
			"stale-controller",
			leaseOwner,
		);
		const lease = await acquireRuntimeCapacityLease({
			leaseScope: "operator",
			organizationId: organizationA,
			operationId: controllerOperation.operationId,
			operationFencingToken: controllerOperation.fencingToken,
			leaseOwner,
			ttlMs: 5 * 60_000,
			cpuMillis: 100,
			memoryMb: 64,
			policy: { architecture: "amd64" },
		});
		if (!lease.runtimeClusterId || !lease.runtimeTargetId)
			throw new Error("Runtime lease has no cluster or target");
		const attempt = await enqueueRuntimeControllerJob({
			operationId: controllerOperation.operationId,
			capacityLeaseId: lease.capacityLeaseId,
			runtimeClusterId: lease.runtimeClusterId,
			kind: "cluster_health",
			request: {},
		});
		await acknowledgeControllerJob({
			operatorJobAttemptId: attempt.operatorJobAttemptId,
			runtimeClusterId: lease.runtimeClusterId,
			runtimeTargetId: lease.runtimeTargetId,
			fencingToken: lease.fencingToken,
		});
		await sql`update "capacityLease" set "expiresAt" = now() - interval '1 second' where "capacityLeaseId" = ${lease.capacityLeaseId}`;
		await expect(
			completeControllerJob({
				operatorJobAttemptId: attempt.operatorJobAttemptId,
				runtimeClusterId: lease.runtimeClusterId,
				runtimeTargetId: lease.runtimeTargetId,
				fencingToken: lease.fencingToken,
				succeeded: true,
				result: { health: "healthy" },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const [current] = await sql<
			[{ status: string }]
		>`select status::text from "operatorJobAttempt" where "operatorJobAttemptId" = ${attempt.operatorJobAttemptId}`;
		expect(current?.status).toBe("acknowledged");
		await reconcileExpiredCapacityLeases({
			limit: 1,
			registry: new CapacityReconciliationRegistry().registerRuntime(
				async () => ({
					status: "clean",
					proofId: "stale-controller-clean",
					placementDrained: true,
				}),
			),
		});
	});

	it("updates only the configured target and derives cluster heartbeat health", async () => {
		await expect(
			heartbeatRuntimeController({
				runtimeClusterId: clusterA,
				runtimeTargetId: targetB,
				controllerVersion: "1.1.0",
				health: "healthy",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const degraded = await heartbeatRuntimeController({
			runtimeClusterId: clusterA,
			runtimeTargetId: targetA,
			controllerVersion: "1.1.0",
			health: "degraded",
		});
		expect(degraded.health).toBe("degraded");
		const healthy = await heartbeatRuntimeController({
			runtimeClusterId: clusterA,
			runtimeTargetId: targetA,
			controllerVersion: "1.1.1",
			health: "healthy",
		});
		expect(healthy.health).toBe("healthy");
		expect(healthy.controllerVersion).toBe("1.1.1");
	});

	it("drain blocks placement and completes only after active leases clear", async () => {
		const activeOperation = await operation(
			organizationA,
			"drain-active",
			"drain-owner",
		);
		const lease = await acquireRuntimeCapacityLease({
			leaseScope: "operator",
			organizationId: organizationA,
			operationId: activeOperation.operationId,
			operationFencingToken: activeOperation.fencingToken,
			leaseOwner: "drain-owner",
			ttlMs: 5 * 60_000,
			cpuMillis: 100,
			memoryMb: 64,
			policy: {
				architecture: "amd64",
				preferredRegionCode: `phase4-a-${suffix}`,
				requiredCapabilities: ["runtime.container", fixtureCapability],
				dataAffinity: { residency: "a" },
			},
		});
		if (!lease.runtimeClusterId)
			throw new Error("Runtime lease did not select a cluster");
		await requestRuntimeClusterDrain(lease.runtimeClusterId);
		const during = await reconcileRuntimeClusterDrain(lease.runtimeClusterId);
		expect(during.complete).toBe(false);
		expect(during.activeLeaseIds).toContain(lease.capacityLeaseId);
		await releaseCapacityLease({
			capacityLeaseId: lease.capacityLeaseId,
			leaseOwner: lease.leaseOwner,
			fencingToken: lease.fencingToken,
		});
		const after = await reconcileRuntimeClusterDrain(lease.runtimeClusterId);
		expect(after.complete).toBe(true);
		const [cluster] = await sql<
			[{ drainState: string }]
		>`select "drainState"::text as "drainState" from "runtimeCluster" where "runtimeClusterId" = ${lease.runtimeClusterId}`;
		expect(cluster?.drainState).toBe("drained");
	});

	it("keeps a cluster draining and reports pinned release blockers", async () => {
		const releaseId = await seedRelease({
			prefix: `phase4_pinned_drain_${suffix}`,
			organizationId: organizationA,
			projectId: projectA,
			environmentId: environmentA,
			status: "ready",
			runtimeTargetId: drainTargetOld,
			runtimePlacementId: `old-placement-${suffix}`,
		});
		await sql`
			insert into "projectPlacementPolicy" (
				"projectId", "organizationId", "preferredRegionCode", "pinToRegion"
			) values (${projectA}, ${organizationA}, ${`phase4-a-${suffix}`}, true)
			on conflict ("projectId") do update
			set "preferredRegionCode" = excluded."preferredRegionCode",
				"pinToRegion" = true, "updatedAt" = now()
		`;
		await requestRuntimeClusterDrain(drainClusterOld);
		const prepare = vi.fn(async () => ({
			runtimeTargetId: drainTargetNew,
			runtimePlacementId: `new-placement-${suffix}`,
			placementHealth: "healthy" as const,
			trafficReady: true as const,
			aliasReady: true as const,
			readinessProof: "alias-cas-ready",
		}));
		const result = await reconcileRuntimeClusterDrain(drainClusterOld, {
			prepare,
			drainPrevious: async () => ({
				drained: true,
				proofId: "old-placement-absent",
			}),
		});
		expect(result.complete).toBe(false);
		expect(result.pinnedReleaseIds).toEqual([releaseId]);
		expect(prepare).not.toHaveBeenCalled();
		const [cluster] = await sql<
			[{ drainState: string }]
		>`select "drainState"::text as "drainState" from "runtimeCluster" where "runtimeClusterId" = ${drainClusterOld}`;
		expect(cluster?.drainState).toBe("draining");
	});

	it("moves target and provider placement only after healthy traffic readiness", async () => {
		await refreshCapacityHealth();
		await sql`update "projectPlacementPolicy" set "pinToRegion" = false where "projectId" = ${projectA}`;
		const releaseId = `phase4_pinned_drain_${suffix}_release`;
		const prepare = vi.fn(async () => ({
			runtimeTargetId: drainTargetNew,
			runtimePlacementId: `new-placement-${suffix}`,
			placementHealth: "healthy" as const,
			trafficReady: true as const,
			aliasReady: true as const,
			readinessProof: "health-and-alias-ready",
		}));
		const drainPrevious = vi.fn(async () => ({
			drained: true as const,
			proofId: "old-placement-drained",
		}));
		const result = await reconcileRuntimeClusterDrain(drainClusterOld, {
			prepare,
			drainPrevious,
		});
		expect(result.complete).toBe(true);
		expect(result.relocatedReleaseIds).toEqual([releaseId]);
		expect(prepare).toHaveBeenCalledOnce();
		expect(drainPrevious).toHaveBeenCalledOnce();
		const [release] = await sql<
			[
				{
					runtimeTargetId: string;
					runtimePlacementId: string;
					runtimeRelocationState: string | null;
				},
			]
		>`
			select "runtimeTargetId", "runtimePlacementId", "runtimeRelocationState"
			from release where "releaseId" = ${releaseId}
		`;
		expect(release).toEqual({
			runtimeTargetId: drainTargetNew,
			runtimePlacementId: `new-placement-${suffix}`,
			runtimeRelocationState: null,
		});
		const [cluster] = await sql<
			[{ drainState: string }]
		>`select "drainState"::text as "drainState" from "runtimeCluster" where "runtimeClusterId" = ${drainClusterOld}`;
		expect(cluster?.drainState).toBe("drained");
	});

	it("fair operation claims prefer a workspace without active leases", async () => {
		const fairClaimKind = `fair-claim-${suffix}`;
		const loadedOperation = await operation(
			organizationA,
			"fair-loaded-active",
			"loaded-owner",
		);
		const loadedLease = await acquireBuildCapacityLease({
			leaseScope: "operator",
			organizationId: organizationA,
			operationId: loadedOperation.operationId,
			operationFencingToken: loadedOperation.fencingToken,
			leaseOwner: "loaded-owner",
			ttlMs: 5 * 60_000,
			capacity: 1,
			policy: {
				architecture: "amd64",
				requiredCapabilities: ["build.rootless", fixtureCapability],
			},
		});
		const queuedA = await startOperation({
			organizationId: organizationA,
			idempotencyKey: `fair-a-${suffix}`,
			kind: fairClaimKind,
			resourceType: "capacity",
		});
		const queuedB = await startOperation({
			organizationId: organizationB,
			idempotencyKey: `fair-b-${suffix}`,
			kind: fairClaimKind,
			resourceType: "capacity",
		});
		const claimed = await claimNextFairOperation({
			kind: fairClaimKind,
			leaseOwner: "fair-scheduler",
			ttlMs: 10_000,
		});
		expect((claimed as { operationId?: string } | null)?.operationId).toBe(
			queuedB.operationId,
		);
		expect((claimed as { operationId?: string } | null)?.operationId).not.toBe(
			queuedA.operationId,
		);
		await releaseCapacityLease({
			capacityLeaseId: loadedLease.capacityLeaseId,
			leaseOwner: loadedLease.leaseOwner,
			fencingToken: loadedLease.fencingToken,
		});
	});

	it("serializes concurrent workspace dispatch and applies fair queue weights", async () => {
		await sql`
			update operation
			set status = 'succeeded', "leaseOwner" = null, "leaseExpiresAt" = null,
				"completedAt" = now(), "updatedAt" = now()
			where "organizationId" in (${organizationA}, ${organizationB})
				and status = 'running'
		`;
		await sql`
			insert into "projectPlacementPolicy" (
				"projectId", "organizationId", "fairQueueWeight"
			) values (${projectA}, ${organizationA}, 100), (${projectB}, ${organizationB}, 100)
			on conflict ("projectId") do update
			set "fairQueueWeight" = excluded."fairQueueWeight", "updatedAt" = now()
		`;
		const concurrentKind = `phase4-concurrent-fair-${suffix}`;
		const queuedA = await startOperation({
			organizationId: organizationA,
			idempotencyKey: `concurrent-a-${suffix}`,
			kind: concurrentKind,
			resourceType: "project",
			resourceId: projectA,
		});
		const queuedB = await startOperation({
			organizationId: organizationB,
			idempotencyKey: `concurrent-b-${suffix}`,
			kind: concurrentKind,
			resourceType: "project",
			resourceId: projectB,
		});
		const concurrent = await Promise.all([
			claimNextFairOperation({
				kind: concurrentKind,
				leaseOwner: "concurrent-scheduler-a",
				ttlMs: 5 * 60_000,
			}),
			claimNextFairOperation({
				kind: concurrentKind,
				leaseOwner: "concurrent-scheduler-b",
				ttlMs: 5 * 60_000,
			}),
		]);
		expect(
			new Set(
				concurrent.map(
					(claim) => (claim as { operationId?: string } | null)?.operationId,
				),
			),
		).toEqual(new Set([queuedA.operationId, queuedB.operationId]));

		await sql`
			update operation
			set status = 'succeeded', "leaseOwner" = null, "leaseExpiresAt" = null,
				"completedAt" = now(), "updatedAt" = now()
			where "operationId" in (${queuedA.operationId}, ${queuedB.operationId})
		`;
		await sql`update "projectPlacementPolicy" set "fairQueueWeight" = 400 where "projectId" = ${projectA}`;
		await sql`update "projectPlacementPolicy" set "fairQueueWeight" = 50 where "projectId" = ${projectB}`;
		const weightedKind = `phase4-weighted-fair-${suffix}`;
		const weightedA = await startOperation({
			organizationId: organizationA,
			idempotencyKey: `weighted-a-${suffix}`,
			kind: weightedKind,
			resourceType: "project",
			resourceId: projectA,
		});
		await startOperation({
			organizationId: organizationB,
			idempotencyKey: `weighted-b-${suffix}`,
			kind: weightedKind,
			resourceType: "project",
			resourceId: projectB,
		});
		const weighted = await claimNextFairOperation({
			kind: weightedKind,
			leaseOwner: "weighted-scheduler",
			ttlMs: 5 * 60_000,
		});
		expect((weighted as { operationId?: string } | null)?.operationId).toBe(
			weightedA.operationId,
		);
	});

	it("customer product DTOs never include provider or machine records", async () => {
		const workspace = await caller({
			organizationId: organizationA,
			userId: userA,
			email: `phase4-a-${suffix}@deploytide.local`,
		}).product.workspaceOverview();
		const serialized = JSON.stringify(workspace);
		for (const forbidden of [
			providerId,
			clusterA,
			targetA,
			"endpointReference",
			"secretReference",
			"providerTargetReference",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it("known legacy server IDs remain undiscoverable until explicit adoption", async () => {
		const serverId = `phase4_legacy_server_${suffix}`;
		await sql`
			insert into server (
				"serverId", name, "ipAddress", port, username, "appName", "createdAt",
				"organizationId", "serverStatus", "serverType", "operatorOwned", "metricsConfig"
			) values (
				${serverId}, 'Legacy Customer Machine', '192.0.2.44', 22, 'root', ${`legacy-${suffix}`},
				'2026-01-01', ${organizationA}, 'active', 'deploy', false,
				'{"server":{"type":"Remote","refreshRate":60,"port":4500,"token":"","urlCallback":"","retentionDays":2,"cronJob":"","thresholds":{"cpu":0,"memory":0}},"containers":{"refreshRate":60,"services":{"include":[],"exclude":[]}}}'::jsonb
			)
		`;
		await sql`update server set command = 'bootstrap --token retained-secret' where "serverId" = ${serverId}`;
		await sql`
			insert into deployment (
				"deploymentId", "organizationId", "serverId", title, status, trigger,
				"logPath", "createdAt"
			) values (
				${`phase4_legacy_deployment_${suffix}`}, ${organizationA}, ${serverId},
				'Retained legacy service', 'ready', 'manual', '/logs/legacy-retained.log',
				'2026-01-01'
			)
		`;
		const retained = await findServerById(serverId);
		expect(retained.operatorOwned).toBe(false);
		expect(
			retained.deployments.map((deployment) => deployment.deploymentId),
		).toContain(`phase4_legacy_deployment_${suffix}`);
		await expect(findOperatorServerById(serverId)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		const customerCaller = caller({
			organizationId: organizationA,
			userId: userA,
			email: `phase4-a-${suffix}@deploytide.local`,
		});
		for (const request of [
			() => customerCaller.server.one({ serverId }),
			() => customerCaller.sshKey.all(),
			() => customerCaller.docker.getContainers({ serverId }),
			() => customerCaller.cluster.getNodes({ serverId }),
			() => customerCaller.swarm.getNodes({ serverId }),
		]) {
			await expect(request()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		}
		vi.stubEnv("DEPLOYTIDE_OPERATOR_API_TOKEN", "operator-api-token");
		const compatibilityCaller = caller({
			organizationId: organizationA,
			userId: userA,
			email: `phase4-a-${suffix}@deploytide.local`,
			headers: { "x-deploytide-operator-token": "operator-api-token" },
		});
		for (const request of [
			() => compatibilityCaller.server.one({ serverId }),
			() => compatibilityCaller.docker.getContainers({ serverId }),
			() => compatibilityCaller.cluster.getNodes({ serverId }),
			() => compatibilityCaller.swarm.getNodes({ serverId }),
		]) {
			await expect(request()).rejects.toMatchObject({ code: "NOT_FOUND" });
		}
		vi.unstubAllEnvs();

		await classifyLegacyInfrastructureInput({
			serverId,
			disposition: "platform_owned",
			reviewNote: "Operator reviewed retained platform host",
			reviewedBy: userA,
		});
		const imported = await importApprovedLegacyInfrastructureInput({
			serverId,
			runtimeClusterId: clusterB,
			architecture: "amd64",
			totalCpuMillis: 500,
			totalMemoryMb: 512,
			reviewedBy: userA,
		});
		expect(imported.target.health).toBe("unknown");
		expect(imported.target.lastHeartbeatAt).toBeNull();
		const repeatedImport = await importApprovedLegacyInfrastructureInput({
			serverId,
			runtimeClusterId: clusterB,
			architecture: "amd64",
			totalCpuMillis: 500,
			totalMemoryMb: 512,
			reviewedBy: userA,
		});
		expect(repeatedImport.target.runtimeTargetId).toBe(
			imported.target.runtimeTargetId,
		);
		expect(repeatedImport.classification.importedRuntimeTargetId).toBe(
			imported.target.runtimeTargetId,
		);
		const [importedTargetCount] = await sql<[{ count: number }]>`
			select count(*)::int as count
			from "runtimeTarget"
			where "runtimeClusterId" = ${clusterB}
				and "providerTargetReference" = ${imported.target.providerTargetReference}
		`;
		expect(importedTargetCount?.count).toBe(1);
		await expect(retireLegacyBootstrapAccess(serverId)).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});
		await heartbeatRuntimeController({
			runtimeClusterId: clusterB,
			runtimeTargetId: imported.target.runtimeTargetId,
			controllerVersion: "1.2.0",
			health: "healthy",
		});
		await expect(retireLegacyBootstrapAccess(serverId)).resolves.toMatchObject({
			serverId,
		});
		const [firstRetirement] = await sql<
			[{ encryptedCheckpoint: string | null }]
		>`
			select "exportPayload" #>> '{bootstrapAccess,encryptedCheckpoint}' as "encryptedCheckpoint"
			from "legacyInfrastructureInput"
			where "serverId" = ${serverId}
		`;
		expect(firstRetirement?.encryptedCheckpoint).toMatch(/^enc:v2:/);
		await expect(retireLegacyBootstrapAccess(serverId)).resolves.toEqual({
			serverId,
		});
		await expect(
			classifyLegacyInfrastructureInput({
				serverId,
				disposition: "customer_owned",
				reviewNote: "Imported inputs cannot be reclassified",
				reviewedBy: userA,
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		await expect(
			exportLegacyInfrastructureInput({ serverId, reviewedBy: userA }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		const [checkpoint] = await sql<
			[
				{
					command: string;
					sshKeyId: string | null;
					exportPayload: {
						bootstrapAccess?: {
							status?: string;
							encryptedCheckpoint?: string;
						};
					};
				},
			]
		>`
			select s.command, s."sshKeyId", l."exportPayload"
			from server s
			join "legacyInfrastructureInput" l on l."serverId" = s."serverId"
			where s."serverId" = ${serverId}
		`;
		expect(checkpoint?.command).toBe("");
		expect(checkpoint?.sshKeyId).toBeNull();
		expect(checkpoint?.exportPayload.bootstrapAccess?.status).toBe("retired");
		expect(checkpoint?.exportPayload.bootstrapAccess?.encryptedCheckpoint).toBe(
			firstRetirement?.encryptedCheckpoint,
		);
		expect(JSON.stringify(checkpoint?.exportPayload)).not.toContain(
			"retained-secret",
		);
	});
});
