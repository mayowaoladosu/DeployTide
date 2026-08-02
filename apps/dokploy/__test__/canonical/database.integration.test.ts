import {
	advanceBranchHead,
	beginDeploymentCancellation,
	createConfigurationSnapshot,
	createGithub,
	createServer,
	deleteProject,
	deleteServer,
	findWorkspaceDeployment,
	findWorkspaceDomain,
	findWorkspaceEnvironment,
	findWorkspaceProject,
	findWorkspaceProjectSource,
	moveAlias,
	putSecret,
	receiveProviderDelivery,
	removeDeployment,
	removeDeploymentsByServerId,
	removeDomainById,
	softDeleteWorkspace,
	transitionAliasStatus,
	transitionDeployment,
	transitionProviderDelivery,
	transitionRelease,
	updateDeployment,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "@/server/api/root";

const databaseUrl = process.env.PHASE2_INTEGRATION_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const sql = postgres(databaseUrl ?? "postgresql://127.0.0.1:1/disabled", {
	max: 4,
});

const orgA = "phase2_integration_org_a";
const orgB = "phase2_integration_org_b";
const orgDelete = "phase2_integration_org_delete";
const projectA = "phase2_integration_project_a";
const projectB = "phase2_integration_project_b";
const environmentA = "phase2_integration_environment_a";
const environmentB = "phase2_integration_environment_b";
const projectDelete = "phase2_integration_project_delete";
const environmentDelete = "phase2_integration_environment_delete";
const workspaceProjectDelete = "phase2_workspace_project_delete";
const workspaceEnvironmentDelete = "phase2_workspace_environment_delete";
const activeCipherPrefix = new RegExp(
	`^enc:v2:${process.env.ENCRYPTION_KEY_ID || "primary"}:`,
);
let ownedGithubId = "";

const cleanupFixtureRows = async () => {
	await sql`drop trigger if exists deploytide_configuration_snapshot_secret_immutable on "configurationSnapshotSecretVersion"`;
	await sql`drop trigger if exists deploytide_configuration_snapshot_immutable on "configurationSnapshot"`;
	await sql`drop trigger if exists deploytide_compose_hard_delete_guard on compose`;
	await sql`drop trigger if exists deploytide_server_hard_delete_guard on server`;
	await sql`drop trigger if exists deploytide_organization_hard_delete_guard on organization`;
	await sql`drop trigger if exists deploytide_project_hard_delete_guard on project`;
	await sql`drop trigger if exists deploytide_environment_hard_delete_guard on environment`;
	await sql`drop trigger if exists deploytide_application_hard_delete_guard on application`;
	await sql`drop trigger if exists deploytide_deployment_hard_delete_guard on deployment`;
	await sql`drop trigger if exists deploytide_domain_hard_delete_guard on domain`;
	await sql`drop trigger if exists deploytide_preview_hard_delete_guard on preview_deployments`;
	await sql`drop trigger if exists deploytide_rollback_hard_delete_guard on rollback`;
	await sql`drop trigger if exists deploytide_environment_variable_hard_delete_guard on "environmentVariable"`;
	await sql`delete from "aliasHistory" where "organizationId" in (${orgA}, ${orgB}, ${orgDelete})`;
	await sql`delete from alias where "organizationId" in (${orgA}, ${orgB}, ${orgDelete})`;
	await sql`delete from rollback where "organizationId" in (${orgA}, ${orgB}, ${orgDelete})`;
	await sql`delete from release where "organizationId" in (${orgA}, ${orgB}, ${orgDelete})`;
	await sql`delete from artifact where "organizationId" in (${orgA}, ${orgB}, ${orgDelete})`;
	await sql`delete from build where "organizationId" in (${orgA}, ${orgB}, ${orgDelete})`;
	await sql`delete from deployment where "organizationId" in (${orgA}, ${orgB}, ${orgDelete})`;
	await sql`delete from "configurationSnapshotSecretVersion" where "organizationId" in (${orgA}, ${orgB}, ${orgDelete})`;
	await sql`delete from "configurationSnapshot" where "organizationId" in (${orgA}, ${orgB}, ${orgDelete})`;
	await sql`delete from organization where id in (${orgA}, ${orgB}, ${orgDelete})`;
	await sql`create trigger deploytide_configuration_snapshot_immutable before update or delete on "configurationSnapshot" for each row execute function deploytide_reject_configuration_snapshot_mutation()`;
	await sql`create trigger deploytide_configuration_snapshot_secret_immutable before update or delete on "configurationSnapshotSecretVersion" for each row execute function deploytide_reject_configuration_snapshot_mutation()`;
	await sql`create trigger deploytide_compose_hard_delete_guard before delete on compose for each row execute function deploytide_reject_compose_hard_delete()`;
	await sql`create trigger deploytide_server_hard_delete_guard before delete on server for each row execute function deploytide_reject_server_hard_delete()`;
	await sql`create trigger deploytide_organization_hard_delete_guard before delete on organization for each row execute function deploytide_reject_retained_hard_delete()`;
	await sql`create trigger deploytide_project_hard_delete_guard before delete on project for each row execute function deploytide_reject_retained_hard_delete()`;
	await sql`create trigger deploytide_environment_hard_delete_guard before delete on environment for each row execute function deploytide_reject_retained_hard_delete()`;
	await sql`create trigger deploytide_application_hard_delete_guard before delete on application for each row execute function deploytide_reject_retained_hard_delete()`;
	await sql`create trigger deploytide_deployment_hard_delete_guard before delete on deployment for each row execute function deploytide_reject_retained_hard_delete()`;
	await sql`create trigger deploytide_domain_hard_delete_guard before delete on domain for each row execute function deploytide_reject_retained_hard_delete()`;
	await sql`create trigger deploytide_preview_hard_delete_guard before delete on preview_deployments for each row execute function deploytide_reject_retained_hard_delete()`;
	await sql`create trigger deploytide_rollback_hard_delete_guard before delete on rollback for each row execute function deploytide_reject_retained_hard_delete()`;
	await sql`create trigger deploytide_environment_variable_hard_delete_guard before delete on "environmentVariable" for each row execute function deploytide_reject_retained_hard_delete()`;
};

const callerFor = (organizationId: string) =>
	appRouter.createCaller({
		db,
		req: { headers: {} },
		res: {},
		session: {
			id: `session-${organizationId}`,
			userId: organizationId === orgA ? "phase2_integration_user_a" : "phase2_integration_user_b",
			activeOrganizationId: organizationId,
		},
		user: {
			id: organizationId === orgA ? "phase2_integration_user_a" : "phase2_integration_user_b",
			ownerId: organizationId === orgA ? "phase2_integration_user_a" : "phase2_integration_user_b",
			email: organizationId === orgA ? "phase2-a@deploytide.local" : "phase2-b@deploytide.local",
			role: "owner",
		},
	} as never);

const seedRelease = async (
	prefix: string,
	organizationId: string,
	projectId: string,
	environmentId: string,
	status: "queued" | "ready" | "failed" | "cancelled",
) => {
	await sql`
		insert into "configurationSnapshot" (
			"configurationSnapshotId", "organizationId", "projectId", "environmentId",
			"serviceType", "serviceId", "sourceConfig", "buildConfig", "runtimeConfig",
			"contentDigest"
		) values (
			${`${prefix}_config`}, ${organizationId}, ${projectId}, ${environmentId},
			'test', ${prefix}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${`sha256:${prefix}`}
		)
	`;
	await sql`
		insert into deployment (
			"deploymentId", "organizationId", "projectId", "environmentId",
			"configurationSnapshotId", title, status, trigger, "logPath", "createdAt", "desiredSequence"
		) values (
			${`${prefix}_deployment`}, ${organizationId}, ${projectId}, ${environmentId},
			${`${prefix}_config`}, ${prefix}, 'ready', 'manual', ${`/logs/${prefix}.log`}, ${new Date().toISOString()}, 1
		)
	`;
	await sql`
		insert into build (
			"buildId", "organizationId", "projectId", "deploymentId", status,
			"buildPlan", "sourceSnapshot"
		) values (
			${`${prefix}_build`}, ${organizationId}, ${projectId}, ${`${prefix}_deployment`},
			'succeeded', '{}'::jsonb, '{}'::jsonb
		)
	`;
	await sql`
		insert into artifact (
			"artifactId", "organizationId", "projectId", "buildId", type, status, digest
		) values (
			${`${prefix}_artifact`}, ${organizationId}, ${projectId}, ${`${prefix}_build`},
			'oci', 'available', ${`sha256:${prefix.padEnd(64, "0").slice(0, 64)}`}
		)
	`;
	await sql`
		insert into release (
			"releaseId", "organizationId", "projectId", "environmentId",
			"deploymentId", "artifactId", status, "runtimeConfigVersion", "serviceIdentity"
		) values (
			${`${prefix}_release`}, ${organizationId}, ${projectId}, ${environmentId},
			${`${prefix}_deployment`}, ${`${prefix}_artifact`}, ${status}, 'v1', ${`service-${prefix}`}
		)
	`;
};

describeDatabase("Phase 2 canonical database invariants", () => {
	beforeAll(async () => {
		await sql`delete from "webServerSettings" where id = 'phase2_crypto_settings'`;
		await cleanupFixtureRows();
		await sql`delete from "user" where id in ('phase2_integration_user_a', 'phase2_integration_user_b')`;
		await sql`
			insert into "user" (id, "expirationDate", "createdAt", email, email_verified, updated_at)
			values
				('phase2_integration_user_a', '2099-01-01', '2026-01-01', 'phase2-a@deploytide.local', true, now()),
				('phase2_integration_user_b', '2099-01-01', '2026-01-01', 'phase2-b@deploytide.local', true, now())
		`;
		await sql`
			insert into organization (id, name, slug, created_at, owner_id)
			values
				(${orgA}, 'Phase 2 A', 'phase2-integration-a', now(), 'phase2_integration_user_a'),
				(${orgB}, 'Phase 2 B', 'phase2-integration-b', now(), 'phase2_integration_user_b'),
				(${orgDelete}, 'Phase 2 Delete', 'phase2-integration-delete', now(), 'phase2_integration_user_a')
		`;
		await sql`
			insert into member (id, organization_id, user_id, role, created_at)
			values
				('phase2_member_a', ${orgA}, 'phase2_integration_user_a', 'owner', now()),
				('phase2_member_b', ${orgB}, 'phase2_integration_user_b', 'owner', now())
		`;
		await sql`
			insert into project ("projectId", name, "createdAt", "organizationId")
			values
				(${projectA}, 'Project A', '2026-01-01', ${orgA}),
				(${projectB}, 'Project B', '2026-01-01', ${orgB}),
				(${projectDelete}, 'Project Delete', '2026-01-01', ${orgA}),
				(${workspaceProjectDelete}, 'Workspace Delete', '2026-01-01', ${orgDelete})
		`;
		await sql`
			insert into environment (
				"environmentId", name, "createdAt", "projectId", "organizationId", "isDefault", kind
			) values
				(${environmentA}, 'Production', '2026-01-01', ${projectA}, ${orgA}, true, 'production'),
				(${environmentB}, 'Production', '2026-01-01', ${projectB}, ${orgB}, true, 'production'),
				(${environmentDelete}, 'Production', '2026-01-01', ${projectDelete}, ${orgA}, true, 'production'),
				(${workspaceEnvironmentDelete}, 'Production', '2026-01-01', ${workspaceProjectDelete}, ${orgDelete}, true, 'production')
		`;
		await sql`
			insert into application (
				"applicationId", name, "appName", "createdAt", "environmentId",
				"organizationId", "projectId"
			) values (
				'phase2_application_a', 'Application A', 'phase2-application-a',
				'2026-01-01', ${environmentA}, ${orgA}, ${projectA}
			)
		`;
		await sql`
			insert into compose (
				"composeId", name, "appName", "composeFile", "createdAt", "environmentId",
				"organizationId", "projectId"
			) values
				('phase2_compose_a', 'Compose A', 'phase2-compose-a', '', '2026-01-01', ${environmentA}, ${orgA}, ${projectA}),
				('phase2_compose_b', 'Compose B', 'phase2-compose-b', '', '2026-01-01', ${environmentB}, ${orgB}, ${projectB})
		`;
		await sql`
			insert into git_provider (
				"gitProviderId", name, "providerType", "createdAt", "organizationId", "userId"
			) values (
				'phase2_foreign_git_provider', 'Foreign GitHub', 'github', '2026-01-01',
				${orgB}, 'phase2_integration_user_b'
			)
		`;
		await sql`
			insert into github ("githubId", "githubAppName", "gitProviderId")
			values ('phase2_foreign_github', 'foreign-app', 'phase2_foreign_git_provider')
		`;
		const ownedGithub = await createGithub(
			{
				name: "Owned GitHub",
				githubAppName: "owned-app",
				githubAppId: 12345,
				githubClientId: "owned-client",
				githubClientSecret: "owned-client-secret",
				githubInstallationId: "owned-installation",
				githubPrivateKey: "owned-private-key",
				githubWebhookSecret: "owned-webhook-secret",
			},
			orgA,
			"phase2_integration_user_a",
		);
		if (!ownedGithub) throw new Error("Failed to create GitHub fixture");
		ownedGithubId = ownedGithub.githubId;
		await sql`
			insert into "configurationSnapshot" (
				"configurationSnapshotId", "organizationId", "projectId", "environmentId",
				"serviceType", "serviceId", "contentDigest"
			) values
				('phase2_transition_config', ${orgA}, ${projectA}, ${environmentA}, 'test', 'phase2_transition_deployment', 'sha256:transition'),
				('phase2_foreign_config', ${orgB}, ${projectB}, ${environmentB}, 'test', 'phase2_foreign_deployment', 'sha256:foreign')
		`;
		await sql`
			insert into deployment (
				"deploymentId", "organizationId", "projectId", "environmentId",
				"configurationSnapshotId", title, status, trigger, "logPath", "createdAt"
			) values
				('phase2_transition_deployment', ${orgA}, ${projectA}, ${environmentA}, 'phase2_transition_config', 'Transition', 'queued', 'manual', '/logs/transition.log', '2026-01-01'),
				('phase2_foreign_deployment', ${orgB}, ${projectB}, ${environmentB}, 'phase2_foreign_config', 'Foreign', 'queued', 'manual', '/logs/foreign.log', '2026-01-01')
		`;
		await sql`
			insert into application (
				"applicationId", name, "appName", "createdAt", "environmentId",
				"organizationId", "projectId"
			) values (
				'phase2_foreign_application', 'Foreign Application', 'foreign-application',
				'2026-01-01', ${environmentB}, ${orgB}, ${projectB}
			)
		`;
		await seedRelease("phase2_release_a1", orgA, projectA, environmentA, "ready");
		await seedRelease("phase2_release_a2", orgA, projectA, environmentA, "ready");
		await seedRelease("phase2_release_failed", orgA, projectA, environmentA, "failed");
		await seedRelease("phase2_release_queued", orgA, projectA, environmentA, "queued");
		await seedRelease("phase2_release_foreign", orgB, projectB, environmentB, "ready");
		await seedRelease(
			"phase2_delete_release",
			orgA,
			projectDelete,
			environmentDelete,
			"ready",
		);
		await sql`
			insert into alias (
				"aliasId", "organizationId", "projectId", "environmentId", kind, status, hostname, version
			) values
				('phase2_alias_cas', ${orgA}, ${projectA}, ${environmentA}, 'production', 'pending', 'cas.phase2.test', 1),
				('phase2_alias_guard', ${orgA}, ${projectA}, ${environmentA}, 'production', 'pending', 'guard.phase2.test', 1)
		`;
		await sql`
			insert into alias (
				"aliasId", "organizationId", "projectId", "environmentId", "releaseId",
				kind, status, hostname, version
			) values (
				'phase2_delete_alias', ${orgA}, ${projectDelete}, ${environmentDelete},
				'phase2_delete_release_release', 'custom', 'disabled',
				'delete.phase2.test', 1
			)
		`;
		await sql`
			insert into domain (
				"domainId", host, https, "createdAt", "organizationId", "projectId", "environmentId", "certificateType", "stripPath", "forwardAuthEnabled"
			) values ('phase2_domain_a', 'phase2.test', true, '2026-01-01', ${orgA}, ${projectA}, ${environmentA}, 'none', false, false)
		`;
		await sql`
			insert into "projectSource" (
				"projectSourceId", "organizationId", "projectId", provider, "defaultBranch", "rootDirectory"
			) values ('phase2_source_a', ${orgA}, ${projectA}, 'github', 'main', '')
		`;
	});

	afterAll(async () => {
		await cleanupFixtureRows();
		await sql`delete from "user" where id in ('phase2_integration_user_a', 'phase2_integration_user_b')`;
		await sql.end();
	});

	it("enforces workspace scoping across project, environment, deployment/log, domain, and source lookups", async () => {
		await expect(findWorkspaceProject(orgB, projectA)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			findWorkspaceEnvironment(orgB, environmentA),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			findWorkspaceDeployment(orgA, "phase2_foreign_deployment"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(findWorkspaceDomain(orgB, "phase2_domain_a")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			findWorkspaceProjectSource(orgB, "phase2_source_a"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(sql`
			insert into alias (
				"aliasId", "organizationId", "projectId", "environmentId", kind,
				status, hostname, version
			) values (
				'phase2_mismatched_alias', ${orgA}, ${projectB}, ${environmentB},
				'production', 'pending', 'mismatch.phase2.test', 1
			)
		`).rejects.toMatchObject({ code: "23503" });
		await expect(sql`
			insert into build (
				"buildId", "organizationId", "projectId", "deploymentId", status,
				attempt, "buildPlan", "sourceSnapshot"
			) values (
				'phase2_mismatched_build', ${orgA}, ${projectA},
				'phase2_release_foreign_deployment', 'queued', 2, '{}'::jsonb, '{}'::jsonb
			)
		`).rejects.toMatchObject({ code: "23503" });
		await expect(sql`
			insert into compose (
				"composeId", name, "appName", "composeFile", "createdAt", "environmentId",
				"organizationId", "projectId"
			) values (
				'phase2_mismatched_compose', 'Mismatched Compose', 'mismatched-compose',
				'', '2026-01-01', ${environmentB}, ${orgA}, ${projectA}
			)
		`).rejects.toMatchObject({ code: "23503" });
		await expect(sql`
			insert into release (
				"releaseId", "organizationId", "projectId", "environmentId",
				"deploymentId", "artifactId", status, attempt, "runtimeConfigVersion",
				"serviceIdentity"
			) values (
				'phase2_mismatched_release', ${orgA}, ${projectA}, ${environmentA},
				'phase2_release_a1_deployment', 'phase2_release_foreign_artifact',
				'queued', 2, 'v1', 'mismatched-release'
			)
		`).rejects.toMatchObject({ code: "23514" });
		await expect(sql`
			insert into release (
				"releaseId", "organizationId", "projectId", "environmentId",
				"deploymentId", "artifactId", status, attempt, "runtimeConfigVersion",
				"serviceIdentity"
			) values (
				'phase2_wrong_deployment_artifact', ${orgA}, ${projectA}, ${environmentA},
				'phase2_release_a1_deployment', 'phase2_release_a2_artifact',
				'queued', 3, 'v1', 'wrong-deployment-artifact'
			)
		`).rejects.toMatchObject({ code: "23514" });
	});

	it("rejects cross-workspace router IDs and customer infrastructure access", async () => {
		const foreign = callerFor(orgB);
		await expect(foreign.project.one({ projectId: projectA })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			foreign.environment.one({ environmentId: environmentA }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			foreign.deployment.readLogs({
				deploymentId: "phase2_transition_deployment",
				tail: 10,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(foreign.domain.one({ domainId: "phase2_domain_a" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			callerFor(orgA).application.update({
				applicationId: "phase2_foreign_application",
				name: "Cross-workspace mutation",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			callerFor(orgA).environment.create({
				projectId: projectB,
				name: "Foreign Environment",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const customer = callerFor(orgA);
		await expect(
			customer.application.move({
				applicationId: "phase2_application_a",
				targetEnvironmentId: environmentB,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			customer.compose.move({
				composeId: "phase2_compose_a",
				targetEnvironmentId: environmentB,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			customer.domain.create({
				host: "foreign-target.phase2.test",
				composeId: "phase2_compose_b",
				domainType: "application",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			customer.application.saveGithubProvider({
				applicationId: "phase2_application_a",
				githubId: "phase2_foreign_github",
				owner: "foreign",
				repository: "repo",
				branch: "main",
				buildPath: "/",
				triggerType: "push",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			customer.github.update({
				githubId: "phase2_foreign_github",
				gitProviderId: "phase2_foreign_git_provider",
				name: "stolen",
				githubAppName: "stolen-app",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const safeGithub = await customer.github.one({ githubId: ownedGithubId });
		expect("githubClientSecret" in safeGithub).toBe(false);
		expect("githubPrivateKey" in safeGithub).toBe(false);
		expect("githubWebhookSecret" in safeGithub).toBe(false);

		await expect(customer.server.all()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(customer.settings.reloadServer()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(customer.network.all({})).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(customer.registry.all()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(customer.certificates.all()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(customer.sshKey.all()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	it("allows only one concurrent alias CAS winner and rejects non-ready or foreign targets", async () => {
		const attempts = await Promise.allSettled([
			moveAlias({
				organizationId: orgA,
				aliasId: "phase2_alias_cas",
				expectedVersion: 1,
				nextReleaseId: "phase2_release_a1_release",
				reason: "concurrent-a1",
				idempotencyKey: "phase2-alias-cas-a1",
			}),
			moveAlias({
				organizationId: orgA,
				aliasId: "phase2_alias_cas",
				expectedVersion: 1,
				nextReleaseId: "phase2_release_a2_release",
				reason: "concurrent-a2",
				idempotencyKey: "phase2-alias-cas-a2",
			}),
		]);
		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
		const [counts] = await sql<[{ history: number; outbox: number }]>
			`select
				(select count(*)::int from "aliasHistory" where "aliasId" = 'phase2_alias_cas') as history,
				(select count(*)::int from "outboxEvent" where "aggregateId" = 'phase2_alias_cas') as outbox`;
		expect(counts).toEqual({ history: 1, outbox: 1 });
		const [winningAlias] = await sql<[{ releaseId: string; version: number }]>
			`select "releaseId", version::int from alias where "aliasId" = 'phase2_alias_cas'`;
		await expect(
			moveAlias({
				organizationId: orgA,
				aliasId: "phase2_alias_cas",
				expectedVersion: 1,
				nextReleaseId: winningAlias!.releaseId,
				reason: "stale no-op must fail",
				idempotencyKey: "phase2-alias-stale-noop",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			transitionRelease({
				organizationId: orgA,
				releaseId: winningAlias!.releaseId,
				expectedStatus: "ready",
				nextStatus: "retired",
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		await expect(
			sql`update release set status = 'retired' where "releaseId" = ${winningAlias!.releaseId}`,
		).rejects.toMatchObject({ code: "23514" });
		const disabledTarget =
			winningAlias!.releaseId === "phase2_release_a1_release"
				? "phase2_release_a2_release"
				: "phase2_release_a1_release";
		await sql`
			insert into alias (
				"aliasId", "organizationId", "projectId", "environmentId", "releaseId",
				kind, status, hostname, version
			) values (
				'phase2_alias_disabled', ${orgA}, ${projectA}, ${environmentA},
				${disabledTarget}, 'custom', 'disabled',
				'disabled.phase2.test', 1
			)
		`;
		await transitionRelease({
			organizationId: orgA,
			releaseId: disabledTarget,
			expectedStatus: "ready",
			nextStatus: "retired",
		});
		await expect(
			transitionAliasStatus({
				organizationId: orgA,
				aliasId: "phase2_alias_disabled",
				expectedVersion: 1,
				expectedStatus: "disabled",
				nextStatus: "pending",
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		await expect(
			sql`update alias set status = 'pending' where "aliasId" = 'phase2_alias_disabled'`,
		).rejects.toMatchObject({ code: "23514" });

		await expect(
			moveAlias({
				organizationId: orgA,
				aliasId: "phase2_alias_guard",
				expectedVersion: 1,
				nextReleaseId: "phase2_release_failed_release",
				reason: "must fail",
				idempotencyKey: "phase2-alias-failed-target",
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		await expect(
			sql`update alias set "releaseId" = 'phase2_release_failed_release' where "aliasId" = 'phase2_alias_guard'`,
		).rejects.toMatchObject({ code: "23514" });
		await expect(
			moveAlias({
				organizationId: orgA,
				aliasId: "phase2_alias_guard",
				expectedVersion: 1,
				nextReleaseId: "phase2_release_foreign_release",
				reason: "must fail",
				idempotencyKey: "phase2-alias-foreign-target",
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	it("keeps the greatest branch sequence under concurrent delivery", async () => {
		await Promise.all([
			advanceBranchHead({
				organizationId: orgA,
				projectId: projectA,
				environmentId: environmentA,
				branch: "main",
				commitSha: "2222222",
				desiredSequence: 2,
				idempotencyKey: "phase2-branch-2",
			}),
			advanceBranchHead({
				organizationId: orgA,
				projectId: projectA,
				environmentId: environmentA,
				branch: "main",
				commitSha: "3333333",
				desiredSequence: 3,
				idempotencyKey: "phase2-branch-3",
			}),
		]);
		const [head] = await sql<[{ commitSha: string; desiredSequence: number }]>
			`select "commitSha", "desiredSequence"::int from "branchHead" where "projectId" = ${projectA} and branch = 'main'`;
		expect(head).toEqual({ commitSha: "3333333", desiredSequence: 3 });
	});

	it("enforces deployment and release state transitions and terminal immutability", async () => {
		for (const [expectedStatus, nextStatus] of [
			["queued", "preparing"],
			["preparing", "deploying"],
			["deploying", "checking"],
			["checking", "ready"],
		] as const) {
			await transitionDeployment({
				organizationId: orgA,
				deploymentId: "phase2_transition_deployment",
				expectedStatus,
				nextStatus,
			});
		}
		await expect(
			updateDeployment("phase2_transition_deployment", { title: "mutated" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			sql`update deployment set title = 'raw mutation' where "deploymentId" = 'phase2_transition_deployment'`,
		).rejects.toMatchObject({ code: "23514" });
		await expect(
			transitionDeployment({
				organizationId: orgA,
				deploymentId: "phase2_transition_deployment",
				expectedStatus: "ready",
				nextStatus: "deploying",
			}),
		).rejects.toThrow(/Invalid deployment transition/);

		for (const [expectedStatus, nextStatus] of [
			["queued", "deploying"],
			["deploying", "checking"],
			["checking", "ready"],
		] as const) {
			await transitionRelease({
				organizationId: orgA,
				releaseId: "phase2_release_queued_release",
				expectedStatus,
				nextStatus,
			});
		}
		await expect(
			transitionRelease({
				organizationId: orgA,
				releaseId: "phase2_release_queued_release",
				expectedStatus: "ready",
				nextStatus: "deploying",
			}),
		).rejects.toThrow(/Invalid release transition/);
		await expect(
			sql`update release set "healthResult" = '{"mutated":true}'::jsonb where "releaseId" = 'phase2_release_queued_release'`,
		).rejects.toMatchObject({ code: "23514" });
	});

	it("locks and cancels the deterministic newest active deployment, including queued work", async () => {
		const olderSnapshot = await createConfigurationSnapshot({
			organizationId: orgA,
			projectId: projectA,
			environmentId: environmentA,
			serviceType: "application",
			serviceId: "phase2_application_a",
			runtimeConfig: { order: "older" },
		});
		const newerSnapshot = await createConfigurationSnapshot({
			organizationId: orgA,
			projectId: projectA,
			environmentId: environmentA,
			serviceType: "application",
			serviceId: "phase2_application_a",
			runtimeConfig: { order: "newer" },
		});
		await sql`
			insert into deployment (
				"deploymentId", "organizationId", "projectId", "environmentId",
				"applicationId", "configurationSnapshotId", title, status, trigger,
				"logPath", "createdAt", "desiredSequence"
			) values
				('phase2_cancel_older', ${orgA}, ${projectA}, ${environmentA},
				 'phase2_application_a', ${olderSnapshot.configurationSnapshotId}, 'Older',
				 'queued', 'manual', '/logs/cancel-older.log', '2026-01-02', 10),
				('phase2_cancel_newer', ${orgA}, ${projectA}, ${environmentA},
				 'phase2_application_a', ${newerSnapshot.configurationSnapshotId}, 'Newer',
				 'preparing', 'manual', '/logs/cancel-newer.log', '2026-01-03', 11)
		`;

		const newest = await beginDeploymentCancellation({
			organizationId: orgA,
			applicationId: "phase2_application_a",
		});
		expect(newest).toMatchObject({
			canonicalCancellation: true,
			deployment: {
				deploymentId: "phase2_cancel_newer",
				status: "cancelling",
			},
		});
		await transitionDeployment({
			organizationId: orgA,
			deploymentId: "phase2_cancel_newer",
			expectedStatus: "cancelling",
			nextStatus: "cancelled",
		});

		const queued = await beginDeploymentCancellation({
			organizationId: orgA,
			applicationId: "phase2_application_a",
		});
		expect(queued).toMatchObject({
			canonicalCancellation: false,
			deployment: {
				deploymentId: "phase2_cancel_older",
				status: "cancelled",
			},
		});
	});

	it("versions secrets atomically without exposing plaintext to operation records", async () => {
		const input = {
			organizationId: orgA,
			projectId: projectA,
			environmentId: environmentA,
			scope: "environment" as const,
			key: "DATABASE_PASSWORD",
			value: "phase2-plaintext-must-not-leak",
			idempotencyKey: "phase2-secret-v1",
		};
		const first = await putSecret(input);
		const repeated = await putSecret(input);
		expect(repeated.currentVersion).toBe(first.currentVersion);
		await expect(
			putSecret({ ...input, value: "different-value-with-reused-key" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await putSecret({
			...input,
			value: "phase2-second-value",
			idempotencyKey: "phase2-secret-v2",
		});

		const versions = await sql<
			{ value: string; operationId: string | null }[]
		>`select value, "operationId" from "secretVersion" where "environmentVariableId" = ${first.environmentVariableId} order by version`;
		expect(versions).toHaveLength(2);
		expect(versions.every((version) => version.value.startsWith("enc:v2:"))).toBe(true);
		expect(JSON.stringify(versions)).not.toContain("phase2-plaintext");
		const operations = await sql<{ input: unknown }[]>
			`select input from operation where "idempotencyKey" in ('phase2-secret-v1', 'phase2-secret-v2')`;
		expect(JSON.stringify(operations)).not.toContain("phase2-plaintext");

		const snapshot = await createConfigurationSnapshot({
			organizationId: orgA,
			projectId: projectA,
			environmentId: environmentA,
			serviceType: "application",
			serviceId: "phase2-secret-snapshot",
			runtimeConfig: { replicas: 1 },
		});
		const links = await sql<
			{ secretVersionId: string; version: number; key: string }[]
		>`
			select csv."secretVersionId", sv.version, csv.key
			from "configurationSnapshotSecretVersion" csv
			join "secretVersion" sv on sv."secretVersionId" = csv."secretVersionId"
			where csv."configurationSnapshotId" = ${snapshot.configurationSnapshotId}
		`;
		expect(links).toEqual([
			expect.objectContaining({ key: "DATABASE_PASSWORD", version: 2 }),
		]);
		await expect(
			sql`update "configurationSnapshot" set "serviceId" = 'mutated' where "configurationSnapshotId" = ${snapshot.configurationSnapshotId}`,
		).rejects.toThrow(/configuration snapshots are immutable/);
	});

	it("stores provider delivery hashes, not provider payloads or canonical state", async () => {
		const first = await receiveProviderDelivery({
			organizationId: orgA,
			projectId: projectA,
			provider: "github",
			externalDeliveryId: "phase2-delivery-1",
			eventType: "push",
			rawBody: '{"token":"provider-secret","after":"abcdef1"}',
		});
		const duplicate = await receiveProviderDelivery({
			organizationId: orgA,
			projectId: projectA,
			provider: "github",
			externalDeliveryId: "phase2-delivery-1",
			eventType: "push",
			rawBody: '{"token":"provider-secret","after":"abcdef1"}',
		});
		expect(duplicate.duplicate).toBe(true);
		await expect(
			receiveProviderDelivery({
				organizationId: orgA,
				projectId: projectA,
				provider: "github",
				externalDeliveryId: "phase2-delivery-1",
				eventType: "push",
				rawBody: '{"after":"different"}',
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await transitionProviderDelivery({
			organizationId: orgA,
			providerDeliveryId: first.delivery.providerDeliveryId,
			expectedStatus: "received",
			nextStatus: "processing",
		});
		await transitionProviderDelivery({
			organizationId: orgA,
			providerDeliveryId: first.delivery.providerDeliveryId,
			expectedStatus: "processing",
			nextStatus: "processed",
		});
		const [payloadColumn] = await sql<[{ count: number }]>
			`select count(*)::int as count from information_schema.columns where table_schema = 'public' and table_name = 'providerDelivery' and column_name = 'payload'`;
		expect(payloadColumn?.count).toBe(0);
		const [serialized] = await sql<[{ body: string }]>
			`select row_to_json(d)::text as body from "providerDelivery" d where "providerDeliveryId" = ${first.delivery.providerDeliveryId}`;
		expect(serialized?.body).not.toContain("provider-secret");
	});

	it("soft-deletes customer records without destroying retained rows", async () => {
		const [guardCoverage] = await sql<[{ count: number }]>
			`select count(*)::int as count from pg_trigger where not tgisinternal and tgname in (
				'deploytide_organization_hard_delete_guard',
				'deploytide_project_hard_delete_guard',
				'deploytide_environment_hard_delete_guard',
				'deploytide_application_hard_delete_guard',
				'deploytide_compose_hard_delete_guard',
				'deploytide_server_hard_delete_guard',
				'deploytide_deployment_hard_delete_guard',
				'deploytide_domain_hard_delete_guard',
				'deploytide_preview_hard_delete_guard',
				'deploytide_rollback_hard_delete_guard',
				'deploytide_environment_variable_hard_delete_guard'
			)`;
		expect(guardCoverage?.count).toBe(11);
		await expect(
			sql`delete from compose where "composeId" = 'phase2_compose_a'`,
		).rejects.toMatchObject({ code: "23514" });
		await expect(
			sql`delete from deployment where "deploymentId" = 'phase2_foreign_deployment'`,
		).rejects.toMatchObject({ code: "23514" });
		await expect(
			sql`delete from project where "projectId" = ${projectA}`,
		).rejects.toMatchObject({ code: "23514" });
		await removeDeployment("phase2_foreign_deployment", orgB);
		await expect(
			findWorkspaceDeployment(orgB, "phase2_foreign_deployment"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const [deployment] = await sql<[{ retained: number; deleted: number }]>
			`select count(*)::int as retained, count(*) filter (where "deletedAt" is not null)::int as deleted from deployment where "deploymentId" = 'phase2_foreign_deployment'`;
		expect(deployment).toEqual({ retained: 1, deleted: 1 });

		await removeDomainById("phase2_domain_a");
		await expect(findWorkspaceDomain(orgA, "phase2_domain_a")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		const [domain] = await sql<[{ retained: number; deleted: number }]>
			`select count(*)::int as retained, count(*) filter (where "deletedAt" is not null)::int as deleted from domain where "domainId" = 'phase2_domain_a'`;
		expect(domain).toEqual({ retained: 1, deleted: 1 });

		await transitionRelease({
			organizationId: orgA,
			releaseId: "phase2_delete_release_release",
			expectedStatus: "ready",
			nextStatus: "retired",
		});
		await deleteProject(projectDelete, orgA);
		await expect(findWorkspaceProject(orgA, projectDelete)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			findWorkspaceEnvironment(orgA, environmentDelete),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const [project] = await sql<
			[{ projects: number; environments: number }]
		>`select
			(select count(*)::int from project where "projectId" = ${projectDelete} and "deletedAt" is not null) as projects,
			(select count(*)::int from environment where "environmentId" = ${environmentDelete} and "deletedAt" is not null) as environments`;
		expect(project).toEqual({ projects: 1, environments: 1 });

		await softDeleteWorkspace(orgDelete);
		const [workspace] = await sql<
			[{ workspaces: number; projects: number; environments: number }]
		>`select
			(select count(*)::int from organization where id = ${orgDelete} and deleted_at is not null) as workspaces,
			(select count(*)::int from project where "projectId" = ${workspaceProjectDelete} and "deletedAt" is not null) as projects,
			(select count(*)::int from environment where "environmentId" = ${workspaceEnvironmentDelete} and "deletedAt" is not null) as environments`;
		expect(workspace).toEqual({ workspaces: 1, projects: 1, environments: 1 });

		const retainedServer = await createServer(
			{
				name: "Retained Server",
				description: "Phase 2 retention fixture",
				ipAddress: "192.0.2.10",
				port: 22,
				username: "root",
				sshKeyId: null,
				serverType: "deploy",
				enableDockerCleanup: false,
			},
			orgA,
		);
		await sql`
			insert into deployment (
				"deploymentId", "organizationId", "serverId", title, status, trigger,
				"logPath", "createdAt"
			) values (
				'phase2_server_deployment', ${orgA}, ${retainedServer.serverId},
				'Server setup', 'ready', 'manual', '/logs/server-setup.log', '2026-01-01'
			)
		`;
		await removeDeploymentsByServerId(retainedServer);
		await deleteServer(retainedServer.serverId);
		const [serverRetention] = await sql<
			[{ serverDeleted: number; deploymentDeleted: number }]
		>`select
			(select count(*)::int from server where "serverId" = ${retainedServer.serverId} and "deletedAt" is not null) as "serverDeleted",
			(select count(*)::int from deployment where "deploymentId" = 'phase2_server_deployment' and "deletedAt" is not null) as "deploymentDeleted"`;
		expect(serverRetention).toEqual({ serverDeleted: 1, deploymentDeleted: 1 });
		await expect(
			sql`delete from server where "serverId" = ${retainedServer.serverId}`,
		).rejects.toMatchObject({ code: "23514" });
	});

	it("migrates encrypted values forward and back to Phase 1-compatible storage", async () => {
		await sql`
			insert into project ("projectId", name, "createdAt", "organizationId", env)
			values ('phase2_crypto_project', 'Crypto Project', '2026-01-01', ${orgA}, 'LEGACY_SECRET=rotate-me')
		`;
		await sql`
			insert into account (
				id, account_id, provider_id, user_id, access_token, refresh_token,
				created_at, updated_at
			) values (
				'phase2_crypto_account', 'phase2-crypto-account', 'github',
				'phase2_integration_user_a', 'legacy-access-token',
				'legacy-refresh-token', now(), now()
			)
		`;
		await sql`
			insert into ai (
				"aiId", name, "apiUrl", "apiKey", model, "organizationId", "createdAt"
			) values (
				'phase2_crypto_ai', 'Crypto AI', 'https://ai.example.test',
				'legacy-ai-key', 'test-model', ${orgA}, '2026-01-01'
			)
		`;
		await sql`
			insert into application (
				"applicationId", name, "appName", "createdAt", "environmentId",
				"organizationId", "projectId", "refreshToken"
			) values (
				'phase2_crypto_application', 'Crypto Application', 'crypto-application',
				'2026-01-01', ${environmentA}, ${orgA}, ${projectA}, 'legacy-app-token'
			)
		`;
		await sql`
			insert into compose (
				"composeId", name, "appName", "composeFile", "environmentId",
				"organizationId", "projectId", "createdAt", "refreshToken"
			) values (
				'phase2_crypto_compose', 'Crypto Compose', 'crypto-compose', '',
				${environmentA}, ${orgA}, ${projectA}, '2026-01-01', 'legacy-compose-token'
			)
		`;
		await sql`
			insert into "webServerSettings" (id, "sshPrivateKey", "metricsConfig")
			values (
				'phase2_crypto_settings', 'legacy-ssh-private-key',
				'{"server":{"type":"Dokploy","refreshRate":60,"port":4500,"token":"legacy-metrics-token","urlCallback":"","retentionDays":2,"cronJob":"","thresholds":{"cpu":0,"memory":0}},"containers":{"refreshRate":60,"services":{"include":[],"exclude":[]}}}'::jsonb
			)
		`;

		await import("../../scripts/migrate-encryption-key");
		const [forward] = await sql<
			[{
				env: string;
				accessToken: string;
				refreshToken: string;
				aiKey: string;
				sshKey: string;
				metrics: string;
				applicationToken: string;
				applicationDigest: string;
				composeToken: string;
				composeDigest: string;
			}]
		>`select
			(select env from project where "projectId" = 'phase2_crypto_project') as env,
			(select access_token from account where id = 'phase2_crypto_account') as "accessToken",
			(select refresh_token from account where id = 'phase2_crypto_account') as "refreshToken",
			(select "apiKey" from ai where "aiId" = 'phase2_crypto_ai') as "aiKey",
			(select "sshPrivateKey" from "webServerSettings" where id = 'phase2_crypto_settings') as "sshKey",
			(select "metricsConfig" #>> '{}' from "webServerSettings" where id = 'phase2_crypto_settings') as metrics,
			(select "refreshToken" from application where "applicationId" = 'phase2_crypto_application') as "applicationToken",
			(select "refreshTokenDigest" from application where "applicationId" = 'phase2_crypto_application') as "applicationDigest",
			(select "refreshToken" from compose where "composeId" = 'phase2_crypto_compose') as "composeToken",
			(select "refreshTokenDigest" from compose where "composeId" = 'phase2_crypto_compose') as "composeDigest"`;
		expect(forward?.env).toMatch(activeCipherPrefix);
		expect(forward?.accessToken).toMatch(activeCipherPrefix);
		expect(forward?.refreshToken).toMatch(activeCipherPrefix);
		expect(forward?.aiKey).toMatch(activeCipherPrefix);
		expect(forward?.sshKey).toMatch(activeCipherPrefix);
		expect(forward?.metrics).toMatch(activeCipherPrefix);
		expect(forward?.applicationToken).toMatch(activeCipherPrefix);
		expect(forward?.applicationDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(forward?.composeToken).toMatch(activeCipherPrefix);
		expect(forward?.composeDigest).toMatch(/^[0-9a-f]{64}$/);
		const defaults = await sql<
			{ tableName: string; columnDefault: string | null }[]
		>`select table_name as "tableName", column_default as "columnDefault"
			from information_schema.columns
			where table_schema = 'public'
				and column_name = 'metricsConfig'
				and table_name in ('server', 'webServerSettings')`;
		expect(defaults).toHaveLength(2);
		expect(defaults.every((column) => column.columnDefault === null)).toBe(true);

		process.env.DEPLOYTIDE_ALLOW_ENCRYPTION_CUTBACK = "true";
		try {
			await import("../../scripts/cutback-encryption-key");
		} finally {
			delete process.env.DEPLOYTIDE_ALLOW_ENCRYPTION_CUTBACK;
		}
		const [cutback] = await sql<
			[{
				env: string;
				accessToken: string;
				refreshToken: string;
				aiKey: string;
				sshKey: string;
				metricsToken: string;
				applicationToken: string;
				composeToken: string;
			}]
		>`select
			(select env from project where "projectId" = 'phase2_crypto_project') as env,
			(select access_token from account where id = 'phase2_crypto_account') as "accessToken",
			(select refresh_token from account where id = 'phase2_crypto_account') as "refreshToken",
			(select "apiKey" from ai where "aiId" = 'phase2_crypto_ai') as "aiKey",
			(select "sshPrivateKey" from "webServerSettings" where id = 'phase2_crypto_settings') as "sshKey",
			(select "metricsConfig" -> 'server' ->> 'token' from "webServerSettings" where id = 'phase2_crypto_settings') as "metricsToken",
			(select "refreshToken" from application where "applicationId" = 'phase2_crypto_application') as "applicationToken",
			(select "refreshToken" from compose where "composeId" = 'phase2_crypto_compose') as "composeToken"`;
		expect(cutback?.env).toMatch(/^enc:v1:/);
		expect(cutback?.accessToken).toBe("legacy-access-token");
		expect(cutback?.refreshToken).toBe("legacy-refresh-token");
		expect(cutback?.aiKey).toBe("legacy-ai-key");
		expect(cutback?.sshKey).toBe("legacy-ssh-private-key");
		expect(cutback?.metricsToken).toBe("legacy-metrics-token");
		expect(cutback?.applicationToken).toBe("legacy-app-token");
		expect(cutback?.composeToken).toBe("legacy-compose-token");
		await sql`delete from "webServerSettings" where id = 'phase2_crypto_settings'`;
	}, 30_000);
});
