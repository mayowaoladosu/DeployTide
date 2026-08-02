export const BRAND = {
	name: "DeployTide",
	description:
		"Managed application delivery from source import to production traffic.",
	relationship: "A LayerRail product",
	repositoryUrl: "https://github.com/mayowaoladosu/DeployTide",
	issuesUrl: "https://github.com/mayowaoladosu/DeployTide/issues",
	discussionsUrl: "https://github.com/mayowaoladosu/DeployTide/discussions",
	logoUrl: "/logo.svg",
	emailLogoUrl:
		"https://raw.githubusercontent.com/mayowaoladosu/DeployTide/deploytide/apps/dokploy/public/logo.svg",
	images: {
		web: "ghcr.io/mayowaoladosu/deploytide",
		monitoring: "ghcr.io/mayowaoladosu/deploytide-monitoring",
		schedules: "ghcr.io/mayowaoladosu/deploytide-schedules",
		api: "ghcr.io/mayowaoladosu/deploytide-api",
	},
} as const;
