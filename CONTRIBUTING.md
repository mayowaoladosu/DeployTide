# Contributing

Thanks for contributing to DeployTide. Changes should preserve the managed-platform customer model described in CONTEXT.md and the accepted ADRs.

Before starting a large feature, discuss it in this repository's GitHub issues.

We have a few guidelines to follow when contributing to this project:

- [Commit Convention](#commit-convention)
- [Setup](#setup)
- [Development](#development)
- [Build](#build)
- [Pull Request](#pull-request)
- [Important Considerations](#important-considerations-for-pull-requests)

## Commit Convention

Before you create a Pull Request, please make sure your commit message follows the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification.

### Commit Message Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

#### Type

Must be one of the following:

- **feat**: A new feature
- **fix**: A bug fix
- **docs**: Documentation only changes
- **style**: Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc)
- **refactor**: A code change that neither fixes a bug nor adds a feature
- **perf**: A code change that improves performance
- **test**: Adding missing tests or correcting existing tests
- **build**: Changes that affect the build system or external dependencies (example scopes: gulp, broccoli, npm)
- **ci**: Changes to our CI configuration files and scripts (example scopes: Travis, Circle, BrowserStack, SauceLabs)
- **chore**: Other changes that don't modify `src` or `test` files
- **revert**: Reverts a previous commit

Example:

```
feat: add new feature
```

## Setup

Create a focused feature branch from `deploytide`, which is the source of truth for this repository.

We use Node v24.4.0 and recommend this specific version. If you have nvm installed, you can run `nvm install 24.4.0 && nvm use` in the root directory.

```bash
git clone https://github.com/mayowaoladosu/DeployTide.git
cd DeployTide
pnpm install
cp apps/dokploy/.env.example apps/dokploy/.env
```

## Requirements

- [Docker](/GUIDES.md#docker)

### Setup

Run the command that will spin up all the required services and files.

```bash
pnpm run deploytide:setup
```

Run this script

```bash
pnpm run server:script
```

Now run the development server.

```bash
pnpm run deploytide:dev
```

Go to http://localhost:3000 to see the development server

> [!NOTE]
> This project uses Biome. If your editor is configured to use another formatter such as Prettier, it's recommended to either change it to use Biome or turn it off.

## Build

```bash
pnpm run deploytide:build
```

## Docker

To build the docker image first run commands to copy .env files

```bash
cp apps/dokploy/.env.production.example .env.production
cp apps/dokploy/.env.production.example apps/dokploy/.env.production
```

then run build command

```bash
pnpm run docker:build
```

To push the docker image

```bash
pnpm run docker:push
```

## Password Reset

In the case you lost your password, you can reset it using the following command

```bash
pnpm run reset-password
```

If you want to test the webhooks on development mode using localtunnel, make sure to install [`localtunnel`](https://localtunnel.app/)

```bash
pnpm dlx localtunnel --port 3000
```

If you run into permission issues of docker run the following command

```bash
sudo chown -R $(whoami) ~/.docker
```

## Application deploy

In case you want to deploy the application on your machine and you selected nixpacks or buildpacks, you need to install first.

```bash
# Install Nixpacks
curl -sSL https://nixpacks.com/install.sh -o install.sh \
    && chmod +x install.sh \
    && ./install.sh
```

```bash
# Install Railpack
curl -sSL https://railpack.com/install.sh | sh
```

```bash
# Install Buildpacks
curl -sSL "https://github.com/buildpacks/pack/releases/download/v0.39.1/pack-v0.39.1-linux.tgz" | tar -C /usr/local/bin/ --no-same-owner -xzv pack
```

## Pull Request

- The `deploytide` branch is the source of truth.
- Create a new branch for each feature or bug fix.
- Make sure to add tests for your changes.
- Update repository documentation when behavior or domain language changes.
- When creating a pull request, please provide a clear and concise description of the changes made.
- If you include a video or screenshot, would be awesome so we can see the changes in action.
- If your pull request fixes an open issue, please reference the issue in the pull request description.
- Once your pull request is merged, you will be automatically added as a contributor to the project.

### Important Considerations for Pull Requests

- **Testing is Mandatory:** All Pull Requests **must be tested** by the PR author before submission. You must verify that your changes work as expected in a local development environment (see [Setup](#setup)). **Pull Requests that have not been tested by their creator will be rejected.** This policy keeps the PR history clean and values contributors who submit verified, working code. Untested PRs are often recognizable by disproportionately large or scattered changes for simple tasks—please test first.
- **Focus and Scope:** Each Pull Request should ideally address a single, well-defined problem or introduce one new feature. This greatly facilitates review and reduces the chances of introducing unintended side effects.
- **Avoid Unfocused Changes:** Please avoid submitting Pull Requests that contain only minor changes such as whitespace adjustments, IDE-generated formatting, or removal of unused variables, unless these are part of a larger, clearly defined refactor or a dedicated "cleanup" Pull Request that addresses a specific `good first issue` or maintenance task.
- **Issue Association:** For any significant change, it's highly recommended to open an issue first to discuss the proposed solution with the community and maintainers. This ensures alignment and avoids duplicated effort. If your PR resolves an existing issue, please link it in the description (e.g., `Fixes #123`, `Closes #456`).
- **Large Features:** Pull Requests that introduce broad features should first be outlined in a GitHub issue so the design remains coherent with DeployTide's product boundary.

Thank you for your contribution!

## Templates

Template-catalog changes should be proposed in a DeployTide issue until a dedicated catalog repository is established.

### Recommendations

- Use the same name of the folder as the id of the template.
- The logo should be in the public folder.
- If you want to show a domain in the UI, please add the `_HOST` suffix at the end of the variable name.
- Test first on a vps or a server to make sure the template works.

## Docs & Website

Documentation for this phase lives in this repository.
