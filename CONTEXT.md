# DeployTide

DeployTide is the language model for a managed application-delivery product operated by LayerRail. These terms describe the product customers use, not its implementation.

## Customer model

**Customer**:
A person or organization that pays for or operates a DeployTide workspace.
_Avoid_: Tenant, account

**User**:
A person who can sign in to one or more workspaces.
_Avoid_: Customer, account

**Workspace**:
The collaboration, access, usage, and billing boundary for a customer.
_Avoid_: Organization, team, account

**Operator**:
LayerRail personnel and systems responsible for platform capacity and reliability.
_Avoid_: Customer administrator, server owner

## Delivery model

**Project**:
A source-connected product boundary that owns environments, deployments, and traffic aliases.
_Avoid_: Application, repository

**Environment**:
A named configuration boundary within a project, such as preview or production.
_Avoid_: Server, cluster

**Deployment**:
A single attempt to turn one source revision and configuration snapshot into a release.
_Avoid_: Release, environment

**Release**:
An immutable runnable result produced by a successful deployment.
_Avoid_: Deployment, container

**Alias**:
A movable traffic name that points to one release at a time.
_Avoid_: Release URL, server route

**Preview**:
A temporary alias and environment used to review an unpromoted change.
_Avoid_: Staging server

**Promotion**:
The act of moving an alias to an existing release without rebuilding it.
_Avoid_: Redeploy

**Rollback**:
The act of moving an alias back to an earlier release without rebuilding it.
_Avoid_: Rebuild, restore

## Platform capacity

**Build Plane**:
Operator-owned capacity that produces immutable release artifacts from source.
_Avoid_: Build server

**Runtime Plane**:
Operator-owned capacity that runs releases independently of build work.
_Avoid_: Customer server, deployment target

**Edge**:
Operator-owned traffic infrastructure that resolves aliases and routes requests to releases.
_Avoid_: Customer proxy, application server
