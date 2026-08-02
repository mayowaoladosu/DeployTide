import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const packageManagerCli = process.env.npm_execpath;
if (!packageManagerCli) {
	throw new Error("npm_execpath is required to run the DeployTide build");
}
const buildEnvironment = {
	...process.env,
	BETTER_AUTH_SECRET:
		process.env.BETTER_AUTH_SECRET ?? randomBytes(32).toString("hex"),
	DATABASE_URL:
		process.env.DATABASE_URL ??
		"postgresql://deploytide-build:deploytide-build@127.0.0.1:9/deploytide-build",
	DEPLOYTIDE_BUILD: "true",
	DEPLOYTIDE_PUBLIC_URL:
		process.env.DEPLOYTIDE_PUBLIC_URL ?? "https://app.deploytide.com",
};

for (const script of ["build-server", "build-next"]) {
	const result = spawnSync(process.execPath, [packageManagerCli, "run", script], {
		cwd: process.cwd(),
		env: buildEnvironment,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
