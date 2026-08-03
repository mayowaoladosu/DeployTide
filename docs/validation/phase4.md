# Phase 4 validation

Phase 4 adds the invisible operator/infrastructure plane behind the Phase 3 product shell: six infrastructure-provider contracts, a global infrastructure schema, capacity leasing and scheduling, a Go runtime controller, a constrained Docker proxy, OpenTofu provisioning, an operator-only browser plane, and hardened BuildKit/registry/edge adapters. None of this is reachable from ordinary customer surfaces.

Verified on Windows, Node 24, Go 1.24.6, PostgreSQL 17, and Docker Desktop.

## Scope

- Six provider contracts (bare-metal/self-hosted, and cloud provisioning adapters) behind a single infrastructure-provider interface.
- Global schema additions: regions, runtime clusters, runtime targets, build pools, capacity leases, controller certificates, operator audit log, operator job attempts, project placement policy, infrastructure incidents/providers, plus a legacy-infrastructure-input shim. Migration head `0185_lame_fantastic_four.sql`.
- Least-loaded capacity leasing/scheduling service with an atomic per-cluster ceiling.
- A separate Go runtime-controller binary (`apps/runtime-controller`) that polls/acks/reports jobs over the operator HTTP protocol and drives a constrained, non-root Docker proxy with no raw socket exposure.
- OpenTofu provisioning templates and HAProxy mTLS ingress config under `infra/`.
- An operator-only browser plane (`/admin/login`, `/admin/infrastructure`, `/admin/infrastructure/[section]`) gated by a signed, HttpOnly session cookie, CSRF-protected same-origin exchange, and a superadmin allowlist; fully separate from the tenant `operatorApi`/customer procedures.
- Hardened BuildKit isolation, registry push, and Traefik edge adapters carried over from Phase 3 with added infrastructure-provider wiring.

## Automated proof

The final tree passed:

- `pnpm --filter @dokploy/server typecheck`;
- `pnpm --filter deploytide typecheck`;
- `pnpm check:license-boundaries`;
- `pnpm check:product-boundaries`;
- `pnpm check:product-shell`;
- `pnpm check:infrastructure-boundaries` (new gate: rejects infrastructure/operator terminology and imports from ordinary customer-facing surfaces, and asserts the operator route files and their auth guards exist);
- `pnpm test`: 753 passed, 9 explicitly skipped OS-scoped tests (0 failed);
- `gofmt -l`, `go vet ./...`, and `go test ./...` for `apps/runtime-controller`: clean;
- runtime-controller and Docker-proxy binaries build for the target platform and their container images run as non-root (65532:65532) with no exposed ports;
- a real BuildKit-to-runtime isolation proof (isolated rootless build → registry push → runtime pull) passed with zero residue and proven secret redaction;
- a fresh PostgreSQL 17 database migration run (`deploytide_phase4_hardening`) applied migration head 0185 cleanly;
- `pnpm deploytide:build`: server bundle and Next.js production build passed, producing the full route manifest including `/admin/login`, `/admin/infrastructure`, `/admin/infrastructure/[section]`, `/api/operator/session`, `/api/operator/csrf`, and the runtime-controller HTTP endpoints under `/api/operator/controllers/[clusterId]/...`.

## Notable fixes made during hardening

- `apps/dokploy/server/wss/authorize.ts`: a WebSocket authorization regression that could authorize a connection before its workspace/project grant was fully checked was found and fixed; full unit suite re-verified green afterward.
- `apps/dokploy/pages/api/operator/session.ts` was found empty (truncated) during final validation and was restored to mint/clear the signed operator session cookie, rate-limit and audit both mint and logout paths, and return only generic 403s on failure.

## Known open items (tracked, not blocking)

- OpenTofu templates currently render provisioning contracts; a real provider plan/apply/destroy integration is future work.
- Weighted-fair capacity scheduling has not been proven against unbounded repeated zero-load cycles for starvation.
- The Docker-registry artifact publication step has a small TOCTOU window between existence-check and push that should be closed with a conditional push.
- The Traefik file-based edge CAS write is not fully process-atomic across concurrent writers.
- HAProxy subject-string formatting versus Node's `X509Certificate.subject` needs a real mTLS handshake validation pass beyond the current isolated proof.
- The outer BuildKit worker still requires a privileged/unconfined bootstrap; this is documented as an explicit rootless-bootstrap prerequisite rather than hidden.
