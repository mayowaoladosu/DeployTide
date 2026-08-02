import { dbUrl } from "@dokploy/server/db";
import {
	decryptValue,
	encryptLegacyValueForCutback,
} from "@dokploy/server/lib/encryption";
import postgres from "postgres";
import { encryptedColumns, quoteIdentifier } from "./encryption-columns";

if (process.env.DEPLOYTIDE_ALLOW_ENCRYPTION_CUTBACK !== "true") {
	throw new Error(
		"DEPLOYTIDE_ALLOW_ENCRYPTION_CUTBACK=true is required for this destructive compatibility operation",
	);
}
if (process.env.DEPLOYTIDE_LEGACY_DECRYPTION !== "enabled") {
	throw new Error(
		"DEPLOYTIDE_LEGACY_DECRYPTION=enabled is required during encryption cutback",
	);
}

const sql = postgres(dbUrl, { max: 1 });
let migrated = 0;

try {
	await sql`select pg_advisory_lock(hashtext('deploytide:encryption-migration:v2'))`;
	for (const target of encryptedColumns) {
		const table = quoteIdentifier(target.table);
		const id = quoteIdentifier(target.id);
		const column = quoteIdentifier(target.column);
		const exists = await sql<{ exists: boolean }[]>`
			select exists (
				select 1
				from information_schema.columns
				where table_schema = 'public'
					and table_name = ${target.table}
					and column_name = ${target.column}
			) as exists
		`;
		if (!exists[0]?.exists) continue;

		const changed = await sql.begin(async (transaction) => {
			const valueExpression = target.phase1Json
				? `${column} #>> '{}'`
				: column;
			const rows = await transaction.unsafe<
				{ id: string; value: string | null }[]
			>(
				`select ${id}::text as id, ${valueExpression} as value from ${table} where ${column} is not null and ${valueExpression} <> '' for update`,
			);
			let columnChanges = 0;
			for (const row of rows) {
				if (!row.value) continue;
				let ciphertext = row.value;
				if (target.phase1Json && row.value.startsWith('"')) {
					try {
						const decoded = JSON.parse(row.value);
						if (typeof decoded === "string") ciphertext = decoded;
					} catch {
						// An already-compatible legacy JSON object needs no conversion.
					}
				}
				const compatible =
					target.phase1Plaintext || target.phase1Json
						? decryptValue(ciphertext)
						: encryptLegacyValueForCutback(ciphertext);
				if (compatible === row.value && !target.phase1Json) continue;
				if (target.phase1Json) JSON.parse(compatible);
				const stored = compatible;
				await transaction.unsafe(
					`update ${table} set ${column} = $1${target.phase1Json ? "::text::jsonb" : ""} where ${id}::text = $2`,
					[stored, row.id],
				);
				columnChanges++;
			}
			return columnChanges;
		});
		migrated += changed;
		console.log(`${target.table}.${target.column}: ${changed} value(s) cut back`);
	}

	let incompatible = 0;
	for (const target of encryptedColumns) {
		const table = quoteIdentifier(target.table);
		const column = quoteIdentifier(target.column);
		const exists = await sql<{ exists: boolean }[]>`
			select exists (
				select 1
				from information_schema.columns
				where table_schema = 'public'
					and table_name = ${target.table}
					and column_name = ${target.column}
			) as exists
		`;
		if (!exists[0]?.exists) continue;
		const predicate = target.phase1Json
			? `jsonb_typeof(${column}) = 'string'`
			: target.phase1Plaintext
				? `${column} like 'enc:%'`
				: `${column} not like 'enc:v1:%'`;
		const nonEmptyPredicate = target.phase1Json
			? `${column} <> 'null'::jsonb`
			: `${column} <> ''`;
		const rows = await sql.unsafe<{ count: string }[]>(
			`select count(*)::text as count from ${table} where ${column} is not null and ${nonEmptyPredicate} and ${predicate}`,
		);
		incompatible += Number(rows[0]?.count ?? 0);
	}
	if (incompatible !== 0) {
		throw new Error(
			`${incompatible} value(s) remain incompatible with Phase 1 code`,
		);
	}
	await sql`
		insert into "canonicalMigrationIssue" (
			"migrationIssueId", "organizationId", "resourceType", "resourceId",
			code, details
		) values (
			'migration_encryption_phase1_compatible', null, 'system', 'encryption',
			'phase1_compatible', jsonb_build_object('verifiedAt', now())
		)
		on conflict ("resourceType", "resourceId", code) do update set
			details = excluded.details,
			"createdAt" = now(),
			"resolvedAt" = null
	`;
	console.log(
		`Encryption cutback complete: ${migrated} value(s) are Phase 1 compatible. Apply the database cutback before starting old code.`,
	);
} finally {
	try {
		await sql`select pg_advisory_unlock(hashtext('deploytide:encryption-migration:v2'))`;
	} finally {
		await sql.end();
	}
}
