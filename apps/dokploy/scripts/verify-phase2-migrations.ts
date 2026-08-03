import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

const migrationsFolder = join(process.cwd(), "drizzle");
const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("DATABASE_URL is required");

const url = new URL(sourceUrl);
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const suffix = `${process.pid}_${Date.now()}`;
const freshDatabase = `deploytide_phase2_fresh_${suffix}`;
const legacyDatabase = `deploytide_phase2_legacy_${suffix}`;
const admin = postgres(adminUrl.toString(), { max: 1 });

const databaseUrl = (name: string) => {
	const target = new URL(url);
	target.pathname = `/${name}`;
	return target.toString();
};

const assert: (condition: unknown, message: string) => asserts condition = (
	condition,
	message,
) => {
	if (!condition) throw new Error(message);
};

const createDatabase = async (name: string) => {
	await admin.unsafe(`create database "${name}"`);
};

const dropDatabase = async (name: string) => {
	await admin.unsafe(`drop database if exists "${name}" with (force)`);
};

const makeLegacyMigrations = async () => {
	const journal = JSON.parse(
		await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
	) as { entries: { idx: number; tag: string }[] };
	journal.entries = journal.entries.filter((entry) => entry.idx <= 176);
	const folder = await mkdtemp(join(tmpdir(), "deploytide-phase2-legacy-"));
	await mkdir(join(folder, "meta"));
	await writeFile(
		join(folder, "meta", "_journal.json"),
		JSON.stringify(journal),
	);
	for (const entry of journal.entries) {
		await copyFile(
			join(migrationsFolder, `${entry.tag}.sql`),
			join(folder, `${entry.tag}.sql`),
		);
	}
	return folder;
};

const migrateFolder = async (sql: Sql, folder: string) => {
	await migrate(drizzle(sql), { migrationsFolder: folder });
};

const seedLegacyFixture = async (sql: Sql) => {
	const statements = [
		`insert into "user" (id, "expirationDate", "createdAt", email, email_verified, updated_at) values ('user_phase2', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'phase2@deploytide.local', true, now())`,
		`insert into organization (id, name, slug, created_at, owner_id) values ('org_phase2', 'Phase 2 Workspace', 'phase-2-workspace', now(), 'user_phase2')`,
		`insert into server ("serverId", name, "ipAddress", port, username, "appName", "createdAt", "organizationId") values ('server_phase2', 'Retained Server', '192.0.2.20', 22, 'root', 'phase2-server', '2026-01-01T00:00:00.000Z', 'org_phase2')`,
		`insert into project ("projectId", name, "createdAt", "organizationId") values ('project_phase2', 'Legacy Project', '2026-01-01T00:00:00.000Z', 'org_phase2')`,
		`insert into environment ("environmentId", name, "createdAt", "projectId", "isDefault") values ('env_prod', 'Production', '2026-01-01T00:00:00.000Z', 'project_phase2', true), ('env_custom', 'QA', '2026-01-02T00:00:00.000Z', 'project_phase2', false)`,
		`insert into application ("applicationId", name, "appName", "sourceType", repository, owner, branch, "buildPath", "autoDeploy", "buildType", "createdAt", "environmentId", "serverId", "isPreviewDeploymentsActive", "watchPaths") values ('app_primary', 'Web', 'phase2-web', 'github', 'deploytide-fixture', 'mayowaoladosu', 'main', '/apps/web', true, 'railpack', '2026-01-01T01:00:00.000Z', 'env_prod', 'server_phase2', true, array['apps/web/**'])`,
		`insert into compose ("composeId", name, "appName", "sourceType", "customGitUrl", "customGitBranch", "createdAt", "environmentId", "serverId") values ('compose_legacy', 'Worker', 'phase2-worker', 'git', 'https://legacy-user:legacy-secret@example.invalid/worker.git', 'stable', '2026-01-02T01:00:00.000Z', 'env_custom', 'server_phase2')`,
		`insert into schedule ("scheduleId", name, "cronExpression", "appName", "scheduleType", command, "serverId", "organizationId", "createdAt") values ('schedule_phase2', 'Retained schedule', '0 * * * *', 'phase2-schedule', 'server', 'echo retained', 'server_phase2', 'org_phase2', '2026-01-02T02:00:00.000Z')`,
		`insert into destination ("destinationId", name, provider, "accessKey", "secretAccessKey", bucket, region, endpoint, "organizationId") values ('destination_phase2', 'Retained destination', 's3', 'legacy-access', 'legacy-secret', 'phase2', 'test', 'https://example.invalid', 'org_phase2')`,
		`insert into backup ("backupId", "appName", schedule, enabled, database, prefix, "destinationId", "backupType", "databaseType", "composeId", "userId") values ('backup_phase2', 'phase2-backup', '0 0 * * *', true, 'phase2', 'retained', 'destination_phase2', 'compose', 'web-server', 'compose_legacy', 'user_phase2')`,
		`insert into preview_deployments ("previewDeploymentId", branch, "pullRequestId", "pullRequestNumber", "pullRequestURL", "pullRequestTitle", "pullRequestCommentId", "appName", "applicationId", "createdAt") values ('preview_42', 'feature/phase-2', 'pr_42', '42', 'https://example.invalid/pull/42', 'Phase 2', 'comment_42', 'phase2-web-pr-42', 'app_primary', '2026-01-03T00:00:00.000Z')`,
		`insert into deployment ("deploymentId", title, status, "logPath", "applicationId", "serverId", "createdAt", description) values ('dep_app_commit', 'App commit', 'done', '/logs/app-commit.log', 'app_primary', 'server_phase2', '2026-01-04T00:00:00.000Z', 'Commit: abcdef123456 feature'), ('dep_app_missing', 'App missing revision', 'done', '/logs/app-missing.log', 'app_primary', 'server_phase2', '2026-01-04T01:00:00.000Z', 'Manual legacy deployment')`,
		`insert into deployment ("deploymentId", title, status, "logPath", "previewDeploymentId", "isPreviewDeployment", "createdAt", description) values ('dep_preview', 'Preview', 'done', '/logs/preview.log', 'preview_42', true, '2026-01-04T02:00:00.000Z', 'Commit: fedcba987654 preview')`,
		`insert into deployment ("deploymentId", title, status, "logPath", "composeId", "createdAt", description) values ('dep_compose', 'Compose', 'done', '/logs/compose.log', 'compose_legacy', '2026-01-04T03:00:00.000Z', 'Commit: 123abc worker')`,
		`insert into deployment ("deploymentId", title, status, "logPath", "createdAt", description) values ('dep_orphan', 'Unowned legacy operation', 'error', '/logs/orphan.log', '2026-01-04T04:00:00.000Z', 'Legacy row with no ownership evidence')`,
		`insert into domain ("domainId", host, https, "createdAt", "applicationId", "certificateType", "stripPath", "forwardAuthEnabled") values ('domain_app', 'app.example.test', true, '2026-01-05T00:00:00.000Z', 'app_primary', 'none', false, false)`,
		`insert into domain ("domainId", host, https, "createdAt", "certificateType", "stripPath", "forwardAuthEnabled") values ('domain_orphan', 'orphan.example.test', false, '2026-01-05T01:00:00.000Z', 'none', false, false)`,
		`insert into rollback ("rollbackId", "deploymentId", image, "createdAt", "fullContext") values ('rollback_legacy', 'dep_app_commit', 'phase2-web:v1', '2026-01-06T00:00:00.000Z', '{"env":"SECRET=must-not-survive","rollbackRegistry":{"password":"must-not-survive"}}'::jsonb)`,
	];
	for (const statement of statements) await sql.unsafe(statement);
};

const rowCounts = async (sql: Sql) => {
	const [row] = await sql.unsafe<
		{
			projects: number;
			environments: number;
			applications: number;
			previews: number;
			deployments: number;
			domains: number;
			rollbacks: number;
			servers: number;
			schedules: number;
			backups: number;
		}[]
	>(`select
		(select count(*)::int from project) as projects,
		(select count(*)::int from environment) as environments,
		(select count(*)::int from application) as applications,
		(select count(*)::int from preview_deployments) as previews,
		(select count(*)::int from deployment) as deployments,
		(select count(*)::int from domain) as domains,
		(select count(*)::int from rollback) as rollbacks,
		(select count(*)::int from server) as servers,
		(select count(*)::int from schedule) as schedules,
		(select count(*)::int from backup) as backups`);
	assert(row, "Could not read fixture row counts");
	return row;
};

const assertCanonicalFixture = async (sql: Sql) => {
	const counts = await rowCounts(sql);
	assert(
		JSON.stringify(counts) ===
			JSON.stringify({
				projects: 1,
				environments: 2,
				applications: 1,
				previews: 1,
				deployments: 5,
				domains: 2,
				rollbacks: 1,
				servers: 1,
				schedules: 1,
				backups: 1,
			}),
		`Canonical row-count parity failed: ${JSON.stringify(counts)}`,
	);
	const [retainedInfrastructure] = await sql.unsafe<
		{
			operatorOwned: boolean;
			applications: number;
			composes: number;
			deployments: number;
			schedules: number;
			backups: number;
			classification: string;
		}[]
	>(`select
		(select "operatorOwned" from server where "serverId" = 'server_phase2') as "operatorOwned",
		(select count(*)::int from application where "serverId" = 'server_phase2') as applications,
		(select count(*)::int from compose where "serverId" = 'server_phase2') as composes,
		(select count(*)::int from deployment where "serverId" = 'server_phase2') as deployments,
		(select count(*)::int from schedule where "serverId" = 'server_phase2') as schedules,
		(select count(*)::int from backup where "composeId" = 'compose_legacy') as backups,
		(select disposition::text from "legacyInfrastructureInput" where "serverId" = 'server_phase2') as classification`);
	assert(
		retainedInfrastructure?.operatorOwned === false &&
			retainedInfrastructure.applications === 1 &&
			retainedInfrastructure.composes === 1 &&
			retainedInfrastructure.deployments === 2 &&
			retainedInfrastructure.schedules === 1 &&
			retainedInfrastructure.backups === 1 &&
			retainedInfrastructure.classification === "ambiguous",
		`0185 broke retained server compatibility: ${JSON.stringify(retainedInfrastructure)}`,
	);

	const [ownership] = await sql.unsafe<
		{ environments: number; applications: number; previews: number }[]
	>(`select
		(select count(*)::int from environment where "organizationId" = 'org_phase2') as environments,
		(select count(*)::int from application where "organizationId" = 'org_phase2' and "projectId" = 'project_phase2') as applications,
		(select count(*)::int from preview_deployments where "organizationId" = 'org_phase2' and "projectId" = 'project_phase2' and "environmentId" = 'env_prod') as previews`);
	assert(
		ownership?.environments === 2 &&
			ownership.applications === 1 &&
			ownership.previews === 1,
		"Direct ownership backfill failed",
	);

	const [project] = await sql.unsafe<
		{ primaryApplicationId: string; productionEnvironments: number }[]
	>(
		`select p."primaryApplicationId", (select count(*)::int from environment where "projectId" = p."projectId" and kind = 'production') as "productionEnvironments" from project p where p."projectId" = 'project_phase2'`,
	);
	assert(
		project?.primaryApplicationId === "app_primary" &&
			project.productionEnvironments === 1,
		"Primary runtime or production environment backfill failed",
	);

	const deployments = await sql.unsafe<
		{
			deploymentId: string;
			organizationId: string | null;
			projectId: string | null;
			environmentId: string | null;
			trigger: string | null;
			sourceProvider: string | null;
			sourceRevision: string | null;
			sourceBranch: string | null;
			sourceConfigSnapshot: unknown;
		}[]
	>(
		`select "deploymentId", "organizationId", "projectId", "environmentId", trigger::text, "sourceProvider", "sourceRevision", "sourceBranch", "sourceConfigSnapshot" from deployment order by "deploymentId"`,
	);
	const byId = new Map(
		deployments.map((deployment) => [deployment.deploymentId, deployment]),
	);
	assert(
		byId.get("dep_app_commit")?.sourceRevision === "abcdef123456" &&
			byId.get("dep_app_commit")?.organizationId === "org_phase2" &&
			byId.get("dep_preview")?.trigger === "git_pull_request" &&
			byId.get("dep_preview")?.sourceBranch === "feature/phase-2" &&
			byId.get("dep_compose")?.sourceRevision === "123abc" &&
			byId.get("dep_compose")?.environmentId === "env_custom" &&
			!JSON.stringify(byId.get("dep_compose")?.sourceConfigSnapshot).includes(
				"legacy-secret",
			),
		"Deployment provenance backfill failed",
	);
	assert(
		byId.get("dep_orphan")?.organizationId === null &&
			byId.get("dep_orphan")?.projectId === null,
		"Orphan deployment ownership was guessed",
	);

	const issues = await sql.unsafe<{ resourceId: string; code: string }[]>(
		`select "resourceId", code from "canonicalMigrationIssue" order by "resourceId", code`,
	);
	const issueKeys = new Set(
		issues.map((issue) => `${issue.resourceId}:${issue.code}`),
	);
	assert(
		issueKeys.has("dep_app_missing:missing_source_revision") &&
			issueKeys.has("dep_orphan:missing_canonical_ownership") &&
			issueKeys.has("domain_orphan:missing_canonical_ownership") &&
			issueKeys.has("compose_legacy:credential_bearing_source_url") &&
			issues.length === 4,
		`Unexpected migration quarantine: ${JSON.stringify(issues)}`,
	);

	const [domain] = await sql.unsafe<
		{
			organizationId: string | null;
			projectId: string | null;
			environmentId: string | null;
		}[]
	>(
		`select "organizationId", "projectId", "environmentId" from domain where "domainId" = 'domain_app'`,
	);
	assert(
		domain?.organizationId === "org_phase2" &&
			domain.projectId === "project_phase2" &&
			domain.environmentId === "env_prod",
		"Domain ownership backfill failed",
	);
	const [rollback] = await sql.unsafe<
		{ organizationId: string | null; fullContext: unknown }[]
	>(
		`select "organizationId", "fullContext" from rollback where "rollbackId" = 'rollback_legacy'`,
	);
	assert(
		rollback?.organizationId === "org_phase2" && rollback.fullContext === null,
		"Rollback ownership or credential purge failed",
	);
	const [source] = await sql.unsafe<
		{
			provider: string;
			repositoryOwner: string;
			repositoryName: string;
			rootDirectory: string;
		}[]
	>(
		`select provider::text, "repositoryOwner", "repositoryName", "rootDirectory" from "projectSource" where "projectId" = 'project_phase2'`,
	);
	assert(
		source?.provider === "github" &&
			source.repositoryOwner === "mayowaoladosu" &&
			source.repositoryName === "deploytide-fixture" &&
			source.rootDirectory === "/apps/web",
		"Project source backfill failed",
	);
};

const runCutback = async (sql: Sql) => {
	const source = await readFile(
		join(migrationsFolder, "cutback", "phase2-to-0176.sql"),
		"utf8",
	);
	const statements = source
		.split("--> statement-breakpoint")
		.map((statement) => statement.trim())
		.filter(Boolean);
	await sql.begin(async (transaction) => {
		for (const statement of statements) await transaction.unsafe(statement);
	});
};

const seedCutbackBuildPoolGate = async (sql: Sql) => {
	await sql.unsafe(`
		insert into "infrastructureProvider" (
			"infrastructureProviderId", name, "adapterType", "endpointReference",
			capabilities, health, status, version, "lastHealthAt"
		) values (
			'cutback_provider', 'Cutback Provider', 'contract-test',
			'internal://cutback-provider', '["build.rootless"]'::jsonb,
			'healthy', 'ready', '1.0.0', now()
		)
	`);
	await sql.unsafe(`
		insert into region (
			"regionId", "infrastructureProviderId", code, name,
			"providerRegionReference", "buildAvailable", "runtimeAvailable", status
		) values (
			'cutback_region', 'cutback_provider', 'cutback-region', 'Cutback Region',
			'cutback-provider-region', true, false, 'ready'
		)
	`);
	await sql.unsafe(`
		insert into "buildPool" (
			"buildPoolId", "infrastructureProviderId", "regionId", name,
			"adapterType", architecture, "workerClass", "maxCapacity",
			"totalCapacity", "cacheNamespace", health, "drainState", version,
			"lastHealthAt"
		) values (
			'cutback_pool', 'cutback_provider', 'cutback_region', 'Cutback Pool',
			'rootless-buildkit', 'amd64', 'fixture', 1, 1, 'cutback-fixture',
			'healthy', 'active', '0.25.1', now()
		)
	`);
};

const removeCutbackBuildPoolGate = async (sql: Sql) => {
	await sql.unsafe(
		`delete from "buildPool" where "buildPoolId" = 'cutback_pool'`,
	);
	await sql.unsafe(`delete from region where "regionId" = 'cutback_region'`);
	await sql.unsafe(`
		delete from "infrastructureProvider"
		where "infrastructureProviderId" = 'cutback_provider'
	`);
};

const seedCutbackRetiredReleasePlacement = async (sql: Sql) => {
	await sql.unsafe(`
		insert into build (
			"buildId", "organizationId", "projectId", "deploymentId", status,
			attempt, "buildPlan", "sourceSnapshot"
		) values (
			'cutback_runtime_build', 'org_phase2', 'project_phase2',
			'dep_app_commit', 'succeeded', 9001, '{}'::jsonb, '{}'::jsonb
		)
	`);
	await sql.unsafe(`
		insert into artifact (
			"artifactId", "organizationId", "projectId", "buildId", type,
			status, digest
		) values (
			'cutback_runtime_artifact', 'org_phase2', 'project_phase2',
			'cutback_runtime_build', 'oci', 'available',
			'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
		)
	`);
	await sql.unsafe(`
		insert into release (
			"releaseId", "organizationId", "projectId", "environmentId",
			"deploymentId", "artifactId", status, attempt, "runtimeConfigVersion",
			"runtimePlacementId", "serviceIdentity", "retiredAt"
		) values (
			'cutback_retired_release', 'org_phase2', 'project_phase2', 'env_prod',
			'dep_app_commit', 'cutback_runtime_artifact', 'retired', 9001, 'v1',
			'retired-placement-must-block', 'cutback-retired-service', now()
		)
	`);
};

const removeCutbackRetiredReleasePlacement = async (sql: Sql) => {
	await sql.unsafe(`
		delete from release where "releaseId" = 'cutback_retired_release'
	`);
	await sql.unsafe(`
		delete from artifact where "artifactId" = 'cutback_runtime_artifact'
	`);
	await sql.unsafe(`
		delete from build where "buildId" = 'cutback_runtime_build'
	`);
};

const assertLegacyAfterCutback = async (sql: Sql) => {
	const counts = await rowCounts(sql);
	assert(
		counts.deployments === 5 &&
			counts.domains === 2 &&
			counts.rollbacks === 1 &&
			counts.servers === 1 &&
			counts.schedules === 1 &&
			counts.backups === 1,
		"Cutback lost legacy rows",
	);
	const [canonical] = await sql<
		[{ canonical: string }]
	>`select to_regclass('public.release')::text as canonical`;
	assert(canonical?.canonical === null, "Cutback retained canonical tables");
	const [states] = await sql.unsafe<{ invalid: number }[]>(
		`select count(*)::int as invalid from deployment where status::text not in ('running', 'done', 'error', 'cancelled')`,
	);
	assert(states?.invalid === 0, "Cutback retained canonical deployment states");
	const [ledger] = await sql.unsafe<{ latest: string }[]>(
		"select max(created_at)::text as latest from drizzle.__drizzle_migrations",
	);
	assert(
		ledger?.latest === "1785274179336",
		"Cutback migration ledger is not at 0176",
	);
	const [compatibility] = await sql.unsafe<
		{
			defaults: number;
			ownerCascade: number;
			rollbackCascade: number;
			scimUnique: number;
		}[]
	>(`select
		(select count(*)::int from information_schema.columns
			where table_schema = 'public' and table_name in ('server', 'webServerSettings')
				and column_name = 'metricsConfig' and column_default is not null) as defaults,
		(select count(*)::int from information_schema.referential_constraints
			where constraint_name = 'organization_owner_id_user_id_fk'
				and delete_rule = 'CASCADE') as "ownerCascade",
		(select count(*)::int from information_schema.referential_constraints
			where constraint_name = 'deployment_rollbackId_rollback_rollbackId_fk'
				and delete_rule = 'CASCADE') as "rollbackCascade",
		(select count(*)::int from pg_constraint
			where conname = 'scim_provider_scim_token_unique') as "scimUnique"`);
	assert(
		compatibility?.defaults === 2 &&
			compatibility.ownerCascade === 1 &&
			compatibility.rollbackCascade === 1 &&
			compatibility.scimUnique === 1,
		"Cutback did not restore Phase 1 defaults and constraints",
	);
};

let legacyFolder: string | undefined;
try {
	await createDatabase(freshDatabase);
	const fresh = postgres(databaseUrl(freshDatabase), { max: 1 });
	try {
		await migrateFolder(fresh, migrationsFolder);
		await migrateFolder(fresh, migrationsFolder);
		const [count] = await fresh.unsafe<{ count: number }[]>(
			`select count(*)::int as count from information_schema.tables where table_schema = 'public' and table_name in ('projectSource','environmentVariable','secretVersion','configurationSnapshot','configurationSnapshotSecretVersion','build','artifact','release','alias','aliasHistory','branchHead','providerDelivery','outboxEvent','operation','canonicalMigrationIssue','infrastructureProvider','region','buildPool','runtimeCluster','runtimeTarget','capacityLease','operatorJobAttempt','controllerCertificate','infrastructureIncident','legacyInfrastructureInput','projectPlacementPolicy','operatorAuditLog')`,
		);
		assert(
			count?.count === 27,
			"Fresh migration is missing canonical or infrastructure tables",
		);
		const [phase4Shape] = await fresh.unsafe<
			{ columns: number; constraints: number }[]
		>(`select
			(select count(*)::int from information_schema.columns
				where table_schema = 'public' and (
					(table_name = 'release' and column_name in (
						'runtimeTargetId', 'runtimePlacementId', 'previousRuntimeTargetId',
						'previousRuntimePlacementId', 'runtimeRelocationId',
						'runtimeRelocationState', 'runtimeRelocationError'
					)) or (table_name = 'capacityLease' and column_name in (
						'leaseScope', 'reconciliationAttempts', 'reconciliationError'
					))
				)) as columns,
			(select count(*)::int from pg_constraint where conname in (
				'capacity_lease_tuple_valid', 'capacity_lease_release_ownership_fk',
				'capacity_lease_runtime_target_cluster_fk', 'operator_job_lease_tuple_fk',
				'release_runtime_relocation_state_valid',
				'project_placement_policy_weight_valid'
			)) as constraints`);
		assert(
			phase4Shape?.columns === 10 && phase4Shape.constraints === 6,
			`Fresh migration is missing hardened Phase 4 shape: ${JSON.stringify(phase4Shape)}`,
		);
	} finally {
		await fresh.end();
	}

	await createDatabase(legacyDatabase);
	legacyFolder = await makeLegacyMigrations();
	const legacy = postgres(databaseUrl(legacyDatabase), { max: 1 });
	try {
		await migrateFolder(legacy, legacyFolder);
		await seedLegacyFixture(legacy);
		const before = await rowCounts(legacy);
		await migrateFolder(legacy, migrationsFolder);
		await migrateFolder(legacy, migrationsFolder);
		await assertCanonicalFixture(legacy);
		const after = await rowCounts(legacy);
		assert(
			JSON.stringify(before) === JSON.stringify(after),
			"Upgrade changed legacy row counts",
		);

		await legacy.unsafe(`
			insert into drizzle.__drizzle_migrations (hash, created_at)
			values ('phase4-unreviewed-head', 1785723026321)
		`);
		let unsupportedHeadBlocked = false;
		try {
			await runCutback(legacy);
		} catch (error) {
			unsupportedHeadBlocked =
				error instanceof Error &&
				/supports migration head 0185 only/.test(error.message);
		}
		assert(
			unsupportedHeadBlocked,
			"SQL cutback did not reject an unreviewed later migration",
		);
		await legacy.unsafe(
			"delete from drizzle.__drizzle_migrations where created_at = 1785723026321",
		);
		await legacy.unsafe(
			`update project set "deletedAt" = now() where "projectId" = 'project_phase2'`,
		);
		let tombstoneCutbackBlocked = false;
		try {
			await runCutback(legacy);
		} catch (error) {
			tombstoneCutbackBlocked =
				error instanceof Error && /tombstones.*reconciled/.test(error.message);
		}
		assert(
			tombstoneCutbackBlocked,
			"SQL cutback did not reject unreconciled tombstones",
		);
		await legacy.unsafe(
			`update project set "deletedAt" = null where "projectId" = 'project_phase2'`,
		);
		await legacy.unsafe(`
			insert into operation (
				"operationId", "organizationId", "idempotencyKey", kind, status,
				"resourceType"
			) values (
				'cutback_pending_operation', 'org_phase2', 'cutback-pending',
				'cutback.test', 'pending', 'system'
			)
		`);
		let pendingWorkCutbackBlocked = false;
		try {
			await runCutback(legacy);
		} catch (error) {
			pendingWorkCutbackBlocked =
				error instanceof Error && /must be drained/.test(error.message);
		}
		assert(
			pendingWorkCutbackBlocked,
			"SQL cutback did not reject in-flight durable work",
		);
		await legacy.unsafe(
			`delete from operation where "operationId" = 'cutback_pending_operation'`,
		);
		await seedCutbackBuildPoolGate(legacy);
		let activeBuildPoolBlocked = false;
		try {
			await runCutback(legacy);
		} catch (error) {
			activeBuildPoolBlocked =
				error instanceof Error &&
				/build pools must be drained/.test(error.message);
		}
		assert(
			activeBuildPoolBlocked,
			"SQL cutback did not reject an active Phase 4 build pool",
		);
		await removeCutbackBuildPoolGate(legacy);

		await seedCutbackRetiredReleasePlacement(legacy);
		let retiredReleasePlacementBlocked = false;
		try {
			await runCutback(legacy);
		} catch (error) {
			retiredReleasePlacementBlocked =
				error instanceof Error &&
				/placement and relocation metadata must be cleared/.test(error.message);
		}
		assert(
			retiredReleasePlacementBlocked,
			"SQL cutback did not reject placement metadata on a retired release",
		);
		await removeCutbackRetiredReleasePlacement(legacy);

		await legacy.unsafe(`
			update "legacyInfrastructureInput"
			set "exportPayload" = '{"bootstrapAccess":{"status":"retired"}}'::jsonb
			where "serverId" = 'server_phase2'
		`);
		let retiredBootstrapBlocked = false;
		try {
			await runCutback(legacy);
		} catch (error) {
			retiredBootstrapBlocked =
				error instanceof Error &&
				/requires explicit restoration/.test(error.message);
		}
		assert(
			retiredBootstrapBlocked,
			"SQL cutback did not reject retired bootstrap access",
		);
		await legacy.unsafe(`
			update "legacyInfrastructureInput"
			set "exportPayload" = null
			where "serverId" = 'server_phase2'
		`);
		await legacy.unsafe(
			`update project set env = 'enc:v2:unconverted:test' where "projectId" = 'project_phase2'`,
		);
		let missingMarkerBlocked = false;
		try {
			await runCutback(legacy);
		} catch (error) {
			missingMarkerBlocked =
				error instanceof Error &&
				/cutback marker is required/.test(error.message);
		}
		assert(
			missingMarkerBlocked,
			"SQL cutback did not require encryption inventory verification",
		);
		await legacy.unsafe(`
			insert into "canonicalMigrationIssue" (
				"migrationIssueId", "organizationId", "resourceType", "resourceId", code
			) values (
				'migration_encryption_phase1_compatible', null, 'system', 'encryption',
				'phase1_compatible'
			)
		`);
		let unsafeCutbackBlocked = false;
		try {
			await runCutback(legacy);
		} catch (error) {
			unsafeCutbackBlocked =
				error instanceof Error &&
				/encryption cutback is required/.test(error.message);
		}
		assert(
			unsafeCutbackBlocked,
			"SQL cutback did not reject unconverted v2 ciphertext",
		);
		await legacy.unsafe(
			`update project set env = '' where "projectId" = 'project_phase2'`,
		);
		await runCutback(legacy);
		await assertLegacyAfterCutback(legacy);
		await migrateFolder(legacy, migrationsFolder);
		await assertCanonicalFixture(legacy);
		const restored = await rowCounts(legacy);
		assert(
			JSON.stringify(before) === JSON.stringify(restored),
			"Re-upgrade changed legacy row counts",
		);
	} finally {
		await legacy.end();
	}
	console.log(
		"Phase 2 migrations verified: fresh, representative upgrade, idempotency, cutback, and re-upgrade.",
	);
} finally {
	if (legacyFolder) await rm(legacyFolder, { recursive: true, force: true });
	await dropDatabase(freshDatabase);
	await dropDatabase(legacyDatabase);
	await admin.end();
}
