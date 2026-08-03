import postgres from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.PHASE2_INTEGRATION_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const sql = postgres(databaseUrl ?? "postgresql://127.0.0.1:1/disabled", {
	max: 2,
});

describeDatabase("Phase 4 persistence hardening", () => {
	it("migrates the release environment gate and bounded job payload checks", async () => {
		const constraints = await sql<{ name: string; definition: string }[]>`
			select conname as name, pg_get_constraintdef(oid) as definition
			from pg_constraint
			where conname in (
				'operator_job_release_environment_empty',
				'operator_job_payload_bounds',
				'controller_certificate_external_key_reference'
			)
			order by conname
		`;
		expect(constraints.map(({ name }) => name)).toEqual([
			"controller_certificate_external_key_reference",
			"operator_job_payload_bounds",
			"operator_job_release_environment_empty",
		]);
		const serialized = JSON.stringify(constraints);
		expect(serialized).toContain("'{}'::jsonb");
		expect(serialized).toContain("1048576");
		expect(serialized).toContain("65536");
		expect(serialized).toContain("operator-secret-id://");
	});

	it("rejects a non-empty release_create environment before persistence", async () => {
		await sql`
			delete from "operatorJobAttempt"
			where "operatorJobAttemptId" = 'hardening-attempt'
		`;
		await expect(
			sql.begin(async (transaction) => {
				await transaction`alter table "operatorJobAttempt" disable trigger all`;
				await transaction`
					insert into "operatorJobAttempt" (
						"operatorJobAttemptId", "operationId", "capacityLeaseId",
						"runtimeClusterId", kind, "fencingToken", request
					) values (
						'hardening-attempt', 'hardening-operation', 'hardening-lease',
						'hardening-cluster', 'release_create', 1,
						${JSON.stringify({ environment: { CONFIG: "plaintext" } })}::jsonb
					)
				`;
			}),
		).rejects.toMatchObject({ code: "23514" });
		const rows = await sql<{ count: number }[]>`
			select count(*)::int as count from "operatorJobAttempt"
			where "operatorJobAttemptId" = 'hardening-attempt'
		`;
		expect(rows[0]?.count).toBe(0);
	});
});
