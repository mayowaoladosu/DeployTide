# Phase 1 validation

Baseline: `Dokploy/dokploy@018e56a7b41f74b99e87351f462e7d5744c01156`

## Required commands

- `pnpm install --frozen-lockfile`
- `pnpm check:license-boundaries`
- `pnpm check:product-boundaries`
- `pnpm --filter=server typecheck`
- `pnpm --filter=deploytide typecheck`
- `pnpm --filter=deploytide exec vitest run --config __test__/vitest.config.ts`
- `pnpm deploytide:build`

Linux CI runs these checks from `.github/workflows/foundation.yml`. Linux-only real deployment tests remain enabled in CI. Windows skips nine tests that invoke POSIX shells, Linux binaries, or privileged symlink behavior; the remaining suite is expected to pass cleanly.

Verified on Windows/Node 24 on 2026-08-02:

- frozen install passed;
- license and product boundary checks passed;
- server and web type checks passed;
- 627 tests passed and 9 explicitly OS-scoped tests skipped;
- changed-file Biome lint passed; and
- the production server and Next.js bundles built successfully without querying a database.

## Security invariants

- Production startup fails unless an auth secret and database credentials are supplied.
- Build-time configuration uses an ephemeral auth secret and an unreachable placeholder database URL; compilation performs no database query.
- Stripe payment failure, cancellation, and customer deletion do not deactivate live runtime servers.
- The public source tree contains no upstream proprietary implementation.
- The original Dokploy whale artwork is replaced by an original DeployTide tide-and-release mark.

The legacy `domain.forwardAuthEnabled` database column remains temporarily for migration compatibility but is absent from create/update API schemas and has no executing implementation. It will be removed in a reviewed canonical-schema migration rather than by a Phase 1 destructive migration.

The inherited OpenAPI artifact was deleted because it advertised removed proprietary and infrastructure-admin routes. Phase 10 will generate the public API from stable DeployTide contracts instead of preserving a false compatibility document.
