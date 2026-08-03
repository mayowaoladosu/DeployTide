# Phase 3 validation

Phase 3 replaces the ordinary customer dashboard with a managed, root-slug product shell built around Workspace → Project → Environment and Deployment → Build → Artifact → Release. Infrastructure placement and credential administration remain outside the customer experience.

Verified on Windows, Node 24, PostgreSQL 17, and Docker Desktop on 2026-08-03.

## Product contract

- Workspace routes use `/{workspaceSlug}` for overview, deployments, activity, domains, usage, and settings.
- Project routes use `/{workspaceSlug}/{projectSlug}` for overview, deployment history/detail, logs, observability, domains, resources, and settings.
- Project slugs are stable, normalized, and unique within a workspace.
- Existing dashboard and service-detail entry points resolve through authenticated root-slug adapters rather than exposing infrastructure administration.
- First-time authenticated users without an active workspace enter `/onboarding` and can create and activate their first workspace without a redirect loop.
- Customer DTOs are explicit allowlists. They exclude placement IDs, host addresses, SSH material, registry references, raw log paths, provider credentials, and secret values.
- Restricted members are filtered by workspace, project, environment, and service grants. Project-wide source, alias, release, build, artifact, variable, and policy metadata is withheld where it cannot be attributed safely.

## Import and release safety

Repository import creates the project and production environment transactionally, creates the first application and source record, audits the action, and queues the initial deployment server-side. Any pre-enqueue failure retires the partial project; cleanup failure is surfaced rather than swallowed.

Archive import necessarily uses a second multipart request. The first response contains a short-lived, user/workspace/project-bound HMAC cleanup proof. Observed upload or queue failures remove waiting jobs, remove extracted code, and retire the created project. Invalid, expired, cross-user, cross-workspace, or cross-project cleanup attempts are rejected. Closing the client between the two requests remains a known lifecycle gap for a later abandoned-import reconciler; observed failures are compensated now.

Production rollback remains an alias compare-and-swap to a retained ready release. It is permission checked, workspace scoped, version checked, and idempotency keyed.

## Automated proof

The final tree passed:

- `pnpm --filter @dokploy/server typecheck`;
- `pnpm --filter deploytide typecheck`;
- `pnpm check:license-boundaries`;
- `pnpm check:product-boundaries`;
- `pnpm check:product-shell`;
- changed-file Biome lint and import-order checks;
- `git diff --check`;
- `pnpm test`: 664 passed, 9 explicitly skipped OS-scoped tests;
- `pnpm deploytide:build`: server bundle and Next.js production build passed.

The product-shell gate asserts all required root-slug route files and rejects infrastructure and credential-management terminology from ordinary customer surfaces. It also runs in Foundation CI.

## PostgreSQL proof

An isolated PostgreSQL 17 container was used for the complete schema lifecycle:

- migration generation reported no unreviewed schema change and generated no migration 0185;
- the migration runner applied head 0184 twice idempotently;
- `phase2:migrations` passed fresh migration, representative legacy upgrade, row/relationship parity, exact-head cutback to 0176, and re-upgrade;
- the final canonical integration suite passed 14 of 14 tests in a newly created disposable database.

The integration suite now proves root-slug tenant isolation, environment/service least privilege, no infrastructure fields in product DTOs, workspace-scoped slug uniqueness, invalid cleanup-proof rejection, atomic project/environment creation, alias CAS, state guards, soft deletion, secret handling, and encryption forward/cutback behavior.

## Browser proof

An authenticated production build was exercised with a real workspace (`Phase Three`), project (`Tideboard`), source import, and retained deployment record.

Twenty-three workspace/project pages were checked at 1440×900 and 390×844. Every route:

- returned HTTP 200;
- rendered exactly one main `h1`;
- had no unnamed button, link, input, select, or textarea;
- contained none of the prohibited customer terms for SSH, host IPs, Docker, Swarm, Traefik, registries, raw ports, server selection, or provider credentials;
- had zero horizontal overflow on mobile (`scrollWidth=380`, `innerWidth=390`).

The repository browser flow created the workspace, project, production environment, application, source record, and initial deployment request. Execution on the original local non-Swarm engine failed at the inherited runtime boundary, but creation and queue semantics were proven; this is not presented as a successful runtime deployment.

## Full production runtime

The exact final bundle was started through the production package command with a temporary single-node Swarm prerequisite. Migration, operational initialization, cron registration, and the deployment worker completed. Both `/api/health` and the rendered root page returned HTTP 200.

This smoke exposed and fixed a custom-server-only React runtime mismatch: the start command now sets `NODE_ENV=production` before ESM evaluates any React-using dependency. The Docker engine was returned to its original non-Swarm state and all temporary web processes were stopped after validation.

## Adversarial review

Three read-only adversarial audits reviewed SSR and tRPC tenancy, cross-workspace leakage, environment/service permissions, DTO field exposure, import compensation, cleanup authorization, deployment/log authorization, rollback correctness, legacy adapters, onboarding, and migration 0184. The final audit reported no Phase 3 blockers.
