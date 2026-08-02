import { dbUrl } from "@dokploy/server/db";
import {
	activeEncryptionKeyId,
	decryptValue,
	isActiveEncryptionValue,
	rotateEncryptionValue,
} from "@dokploy/server/lib/encryption";
import { digestDeploymentToken } from "@dokploy/server/lib/sensitive-digest";
import postgres from "postgres";
import {
	deploymentTokenColumns,
	encryptedColumns,
	quoteIdentifier,
} from "./encryption-columns";

if (activeEncryptionKeyId === "auth") {
	throw new Error(
		"A dedicated ENCRYPTION_KEY and non-auth ENCRYPTION_KEY_ID are required before migration",
	);
}
if (process.env.DEPLOYTIDE_LEGACY_DECRYPTION === "disabled") {
	throw new Error(
		"DEPLOYTIDE_LEGACY_DECRYPTION must remain enabled until migration completes",
	);
}

const sql = postgres(dbUrl, { max: 1 });
let migrated = 0;

try {
	await sql`select pg_advisory_lock(hashtext('deploytide:encryption-migration:v2'))`;
	await sql`
		delete from "canonicalMigrationIssue"
		where "resourceType" = 'system'
			and "resourceId" = 'encryption'
			and code = 'phase1_compatible'
	`;
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
				let plaintextOrCiphertext = row.value;
				let needsJsonNormalization = false;
				if (target.phase1Json && row.value.startsWith('"')) {
					try {
						const decoded = JSON.parse(row.value);
						if (typeof decoded === "string") {
							plaintextOrCiphertext = decoded;
							needsJsonNormalization = true;
						}
					} catch {
						// Legacy JSON object text is intentionally handled as plaintext.
					}
				}
				if (
					isActiveEncryptionValue(plaintextOrCiphertext) &&
					!needsJsonNormalization
				) {
					continue;
				}
				const encrypted = isActiveEncryptionValue(plaintextOrCiphertext)
					? plaintextOrCiphertext
					: rotateEncryptionValue(plaintextOrCiphertext);
				const stored = encrypted;
				await transaction.unsafe(
					`update ${table} set ${column} = $1${target.phase1Json ? "::jsonb" : ""} where ${id}::text = $2`,
					[stored, row.id],
				);
				columnChanges++;
			}
			return columnChanges;
		});
		migrated += changed;
		console.log(`${target.table}.${target.column}: ${changed} value(s) migrated`);
	}
	for (const target of encryptedColumns.filter((column) => column.phase1Json)) {
		const table = quoteIdentifier(target.table);
		const column = quoteIdentifier(target.column);
		await sql.unsafe(
			`alter table ${table} alter column ${column} drop default`,
		);
	}
	for (const target of deploymentTokenColumns) {
		const table = quoteIdentifier(target.table);
		const id = quoteIdentifier(target.id);
		const tokenColumn = quoteIdentifier(target.tokenColumn);
		const digestColumn = quoteIdentifier(target.digestColumn);
		const rows = await sql.unsafe<{ id: string; token: string }[]>(
			`select ${id}::text as id, ${tokenColumn} as token from ${table} where ${tokenColumn} is not null and ${tokenColumn} <> '' for update`,
		);
		for (const row of rows) {
			await sql.unsafe(
				`update ${table} set ${digestColumn} = $1 where ${id}::text = $2`,
				[digestDeploymentToken(decryptValue(row.token)), row.id],
			);
		}
		console.log(
			`${target.table}.${target.digestColumn}: ${rows.length} lookup digest(s) verified`,
		);
	}

	let remaining = 0;
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
		const valueExpression = target.phase1Json
			? `${column} #>> '{}'`
			: column;
		const rows = await sql.unsafe<{ count: string }[]>(
			`select count(*)::text as count from ${table} where ${column} is not null and ${valueExpression} <> '' and ${valueExpression} not like $1`,
			[`enc:v2:${activeEncryptionKeyId}:%`],
		);
		remaining += Number(rows[0]?.count ?? 0);
	}
	if (remaining !== 0) {
		throw new Error(`${remaining} encrypted value(s) remain on a legacy key`);
	}
	let missingDigests = 0;
	for (const target of deploymentTokenColumns) {
		const table = quoteIdentifier(target.table);
		const tokenColumn = quoteIdentifier(target.tokenColumn);
		const digestColumn = quoteIdentifier(target.digestColumn);
		const rows = await sql.unsafe<{ count: string }[]>(
			`select count(*)::text as count from ${table} where ${tokenColumn} is not null and ${tokenColumn} <> '' and (${digestColumn} is null or ${digestColumn} !~ '^[0-9a-f]{64}$')`,
		);
		missingDigests += Number(rows[0]?.count ?? 0);
	}
	if (missingDigests !== 0) {
		throw new Error(`${missingDigests} deployment token digest(s) are missing`);
	}
	console.log(
		`Encryption migration complete: ${migrated} value(s) now use v2:${activeEncryptionKeyId}. Set DEPLOYTIDE_LEGACY_DECRYPTION=disabled and restart all processes.`,
	);
} finally {
	try {
		await sql`select pg_advisory_unlock(hashtext('deploytide:encryption-migration:v2'))`;
	} finally {
		await sql.end();
	}
}
