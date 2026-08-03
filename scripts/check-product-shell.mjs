import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const customerFiles = [
	"apps/dokploy/components/layouts/side.tsx",
	"apps/dokploy/components/layouts/user-nav.tsx",
	"apps/dokploy/components/dashboard/search-command.tsx",
	"apps/dokploy/components/navigation/product-navigation.tsx",
	"apps/dokploy/components/navigation/workspace-switcher.tsx",
	"apps/dokploy/components/workspace-overview/workspace-overview.tsx",
	"apps/dokploy/components/workspace-overview/workspace-surface.tsx",
	"apps/dokploy/components/workspace-overview/workspace-onboarding.tsx",
	"apps/dokploy/components/project-overview/project-overview.tsx",
	"apps/dokploy/components/project-overview/project-surface.tsx",
	"apps/dokploy/components/project-overview/deployment-detail.tsx",
	"apps/dokploy/components/project-overview/import-project.tsx",
];
const routeFiles = [
	"apps/dokploy/pages/new.tsx",
	"apps/dokploy/pages/onboarding.tsx",
	"apps/dokploy/pages/[workspaceSlug]/index.tsx",
	"apps/dokploy/pages/[workspaceSlug]/deployments.tsx",
	"apps/dokploy/pages/[workspaceSlug]/activity.tsx",
	"apps/dokploy/pages/[workspaceSlug]/domains.tsx",
	"apps/dokploy/pages/[workspaceSlug]/usage.tsx",
	"apps/dokploy/pages/[workspaceSlug]/[projectSlug]/index.tsx",
	"apps/dokploy/pages/[workspaceSlug]/[projectSlug]/deployments.tsx",
	"apps/dokploy/pages/[workspaceSlug]/[projectSlug]/[deploymentId].tsx",
	"apps/dokploy/pages/[workspaceSlug]/[projectSlug]/logs.tsx",
	"apps/dokploy/pages/[workspaceSlug]/[projectSlug]/observability.tsx",
	"apps/dokploy/pages/[workspaceSlug]/[projectSlug]/domains.tsx",
	"apps/dokploy/pages/[workspaceSlug]/[projectSlug]/resources.tsx",
	"apps/dokploy/pages/[workspaceSlug]/[projectSlug]/settings/index.tsx",
	"apps/dokploy/pages/[workspaceSlug]/[projectSlug]/settings/[section].tsx",
];
const forbidden = [
	/\bSSH\b/i,
	/\bserver\s+IP\b/i,
	/\bDocker\b/i,
	/\bSwarm\b/i,
	/\bTraefik\b/i,
	/\bregistry\b/i,
	/\braw\s+port\b/i,
	/select\s+a\s+server/i,
	/client\s+secret/i,
	/private\s+key/i,
	/api\s+token/i,
	/provider\s+credentials/i,
];

const problems = [];
for (const relative of [...customerFiles, ...routeFiles]) {
	const absolute = resolve(root, relative);
	if (!existsSync(absolute)) {
		problems.push(`${relative}: missing required product surface`);
		continue;
	}
	if (!customerFiles.includes(relative)) continue;
	const source = readFileSync(absolute, "utf8");
	for (const pattern of forbidden) {
		if (pattern.test(source)) problems.push(`${relative}: contains forbidden customer terminology ${pattern}`);
	}
}

if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}
console.log(`Product shell verified: ${routeFiles.length} complete root-slug routes and no infrastructure terminology.`);
