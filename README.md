# DeployTide

DeployTide is LayerRail's managed application-delivery platform. The customer
model is source import, framework detection, immutable deployments, previews,
promotion, domains, logs, rollback, usage, and billing. Compute infrastructure
is operated by LayerRail and is not a customer-managed resource.

This repository is the standalone DeployTide codebase. It is in active
development; no public service domain or installation endpoint is claimed by
this document.

## Product principles

- **Git to release** — turn a source revision and configuration snapshot into an
  immutable release.
- **Aliases, not rebuilds** — promote and roll back by moving traffic aliases
  between existing releases.
- **Preview by default** — give unpromoted changes isolated review URLs.
- **Managed capacity** — keep customer workflows independent from servers,
  clusters, and infrastructure providers.
- **Separate planes** — scale disposable build work independently from
  availability-sensitive runtimes.

The domain language is defined in [CONTEXT.md](CONTEXT.md), and durable
architectural decisions are recorded in [docs/adr](docs/adr).

## Development

Requirements:

- Node.js 24.4 or newer in the Node 24 line
- pnpm 10.22 or newer
- PostgreSQL, Redis, and Docker for integration workflows

Install and validate the workspace:

```bash
pnpm install --frozen-lockfile
pnpm check:license-boundaries
pnpm typecheck
pnpm test
```

The current source directory name `apps/dokploy`, internal `@dokploy/server`
package alias, database identifiers, and selected runtime paths are temporary
compatibility boundaries inherited from the Apache-licensed foundation. They
are not the product name and must not be used in customer-facing copy.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local workflow.

## Licensing and attribution

DeployTide is licensed under the Apache License, Version 2.0. The codebase is
derived from the Apache-licensed portions of
[Dokploy](https://github.com/Dokploy/dokploy). All source that upstream placed
under `proprietary` directories has been removed; no DSAL implementation is
included. See [LICENSE.MD](LICENSE.MD) and [NOTICE](NOTICE).
