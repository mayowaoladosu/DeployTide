# Phase 2 validation and cutback

Phase 2 adds DeployTide's canonical workspace, source, deployment, build, artifact, release, alias, secret, provider-delivery, outbox, and operation records without dropping the retained Dokploy compatibility fields.

## Production key transition

Production requires an independent `ENCRYPTION_KEY`, a stable `ENCRYPTION_KEY_ID`, and an explicit `DEPLOYTIDE_LEGACY_DECRYPTION` setting.
Set an independent `DEPLOYTIDE_SECRET_DIGEST_KEY` for keyed secret idempotency and deployment-token lookup digests.

1. Back up PostgreSQL and the active encryption keys.
2. Deploy with `DEPLOYTIDE_LEGACY_DECRYPTION=enabled` and keep the prior keys in `DEPLOYTIDE_ENCRYPTION_KEYRING`.
3. Run `pnpm --filter=deploytide encryption:migrate` once against the production database.
4. Confirm the command reports zero remaining legacy values.
5. Set `DEPLOYTIDE_LEGACY_DECRYPTION=disabled` and restart every process.
6. Retain the previous key only for the approved rollback window, then remove it from the keyring.

The migration command takes a PostgreSQL advisory lock, updates the complete reversible credential inventory transactionally, backfills keyed deployment-token lookup digests, never logs values, and refuses to run without a dedicated active key.

## Emergency code cutback

Phase 1 code cannot read v2 ciphertext and expects OAuth/account tokens as plaintext. Before applying the SQL cutback or starting Phase 1 code:

1. Stop all writers and take a restorable database snapshot.
2. Keep `DEPLOYTIDE_LEGACY_DECRYPTION=enabled` and the rollback keyring available.
3. Set `DEPLOYTIDE_ALLOW_ENCRYPTION_CUTBACK=true` for this command only.
4. Run `pnpm --filter=deploytide encryption:cutback` while Phase 2 code is still installed.
5. Apply the reviewed SQL cutback, then start the old code.

The cutback command converts encrypted environment/configuration fields to authenticated `enc:v1` values and restores fields Phase 1 stored as plaintext, including OAuth and deployment tokens. It takes the same advisory lock as forward migration and fails if any incompatible value remains. Never leave the cutback approval variable enabled.

The SQL cutback is exact-head gated. It refuses to run with a later migration, any workspace/project-facing tombstone, pending durable operation/outbox/build/release/delivery/alias work, or a missing encryption inventory marker. Workspace, project, environment, application, Compose, server, deployment, domain, preview, rollback, and environment-variable tables also reject raw hard deletes; reconcile records explicitly rather than silently resurrecting or dropping state.

## Database proof

Run against an isolated PostgreSQL 17 instance:

- `pnpm --filter=deploytide migration:run` twice proves fresh application and migrator idempotency.
- `pnpm --filter=deploytide phase2:migrations` proves representative legacy backfill, orphan quarantine, row and relationship parity, cutback to migration 0176, and re-upgrade.
- `pnpm --filter=deploytide test:phase2-db` proves workspace IDOR rejection, customer/operator separation, alias CAS, newest-commit-wins branch heads, database state guards, secret versioning, provider payload isolation, and soft deletion.

The SQL cutback rehearsal is additive-data destructive by design: it removes Phase 2 canonical tables and columns after first mapping canonical deployment states back to legacy states. Use it only after the encryption cutback and from a restorable snapshot during the compatibility window. The retained legacy project, environment, application, deployment, domain, and rollback row counts are asserted before and after re-upgrade.
