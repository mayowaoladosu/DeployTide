# Source and license inventory

## Foundation

DeployTide is derived from the Apache-2.0 portions of `Dokploy/dokploy` at audited baseline `018e56a7b41f74b99e87351f462e7d5744c01156`.

- Upstream source: https://github.com/Dokploy/dokploy
- Upstream copyright: Copyright 2026-present Dokploy Technology, Inc.
- Retained-source license: Apache License 2.0
- DeployTide additions: Apache License 2.0

The complete license is in `LICENSE.MD`; required attribution is in `NOTICE`.

## Excluded source

DeployTide does not include files from any upstream `proprietary` directory. The upstream DSAL implementation for license keys, SSO/SCIM, forward authentication, custom roles, audit-log UI, and whitelabeling was removed rather than relicensed or copied.

The generated `openapi.json` was also removed because it described deleted proprietary endpoints and inherited infrastructure APIs. A new public contract will be generated from DeployTide's stable service layer in Phase 10.

## Automated boundary

`pnpm check:license-boundaries` fails when:

- a directory named `proprietary` exists outside ignored build/dependency directories;
- source imports a path containing `/proprietary`;
- `LICENSE_PROPRIETARY.md` exists;
- an application manifest directly depends on the removed Better Auth SSO or SCIM packages; or
- `LICENSE.MD` or `NOTICE` is missing.

Third-party packages remain governed by their own licenses as resolved in `pnpm-lock.yaml`. Dependency and image license reports must be generated for every release before Phase 10 launch approval.
