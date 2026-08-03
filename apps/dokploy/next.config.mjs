import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */

/** @type {import("next").NextConfig} */
const nextConfig = {
	outputFileTracingRoot: repositoryRoot,
	reactStrictMode: true,
	transpilePackages: ["@dokploy/server"],
	async redirects() {
		const legacyWorkspaceRoutes = [
			"/dashboard/deployments",
			"/dashboard/monitoring",
			"/dashboard/schedules",
			"/dashboard/traefik",
			"/dashboard/docker",
			"/dashboard/swarm",
			"/dashboard/networks",
			"/dashboard/requests",
			"/dashboard/settings/server",
			"/dashboard/settings/servers",
			"/dashboard/settings/ssh-keys",
			"/dashboard/settings/registry",
			"/dashboard/settings/destinations",
			"/dashboard/settings/certificates",
			"/dashboard/settings/cluster",
			"/dashboard/settings/deployments",
		];
		return legacyWorkspaceRoutes.map((source) => ({
			source,
			destination: "/dashboard/home",
			permanent: false,
		}));
	},
	async headers() {
		return [
			{
				// Apply security headers to all routes
				source: "/:path*",
				headers: [
					{
						key: "X-Frame-Options",
						value: "DENY",
					},
					{
						key: "Content-Security-Policy",
						value: "frame-ancestors 'none'",
					},
					{
						key: "X-Content-Type-Options",
						value: "nosniff",
					},
					{
						key: "Referrer-Policy",
						value: "strict-origin-when-cross-origin",
					},
				],
			},
		];
	},
};

export default nextConfig;
