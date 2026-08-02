import { readFile } from "node:fs/promises";
import process from "node:process";

const checks = [
	{
		path: "apps/dokploy/pages/api/stripe/webhook.ts",
		forbidden: [
			[/\bdisableServers\b/, "billing webhook defines or calls disableServers"],
			[/\.update\(server\)/, "billing webhook updates runtime server records"],
			[/serverStatus\s*:\s*["']inactive["']/, "billing webhook deactivates runtime capacity"],
		],
	},
	{
		path: "packages/server/src/lib/auth-secret.ts",
		forbidden: [
			[/better-auth-secret-123456789/, "legacy production auth secret remains"],
		],
	},
];

const violations = [];
for (const check of checks) {
	const source = await readFile(check.path, "utf8");
	for (const [pattern, message] of check.forbidden) {
		if (pattern.test(source)) violations.push(`${check.path}: ${message}`);
	}
}

if (violations.length > 0) {
	console.error("Product-boundary violations:\n");
	for (const violation of violations) console.error(`- ${violation}`);
	process.exit(1);
}

console.log("Product boundaries verified: billing cannot disable production.");
