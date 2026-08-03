import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const customerRoots = [
	"apps/dokploy/components/navigation",
	"apps/dokploy/components/product-shell",
	"apps/dokploy/components/project-overview",
	"apps/dokploy/components/workspace-overview",
	"apps/dokploy/pages/[workspaceSlug]",
];
const requiredOperatorFiles = [
	"apps/dokploy/pages/admin/login.tsx",
	"apps/dokploy/pages/admin/infrastructure/index.tsx",
	"apps/dokploy/pages/admin/infrastructure/[section].tsx",
	"apps/dokploy/pages/api/operator/csrf.ts",
	"apps/dokploy/server/api/routers/infrastructure.ts",
	"apps/dokploy/server/operator-auth.ts",
	"apps/runtime-controller/main.go",
	"infra/opentofu/main.tf",
	"packages/server/src/infrastructure/contracts.ts",
	"packages/server/src/services/capacity/leases.ts",
];
const infrastructureWords = [
	/\b(?:add|create|enroll|import|manage|select)\s+(?:a\s+)?server\b/i,
	/\bnode\s+selector\b/i,
	/\bserver\s+health\b/i,
	/\bcluster(?:s)?\b/i,
	/\bbuild\s+pool(?:s)?\b/i,
	/\bprovider\s+credential(?:s)?\b/i,
	/\bSSH\b/i,
	/\bDocker\b/i,
	/\bSwarm\b/i,
	/\bTraefik\b/i,
	/\bBuildKit\b/i,
	/\bmachine\s+ID(?:s)?\b/i,
	/\bprivate\s+endpoint(?:s)?\b/i,
];

const filesUnder = (relative) => {
	const absolute = resolve(root, relative);
	if (!existsSync(absolute)) return [];
	if (!statSync(absolute).isDirectory()) return [absolute];
	return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
		const child = `${relative}/${entry.name}`;
		return entry.isDirectory() ? filesUnder(child) : [resolve(root, child)];
	});
};

const problems = [];
for (const relative of requiredOperatorFiles) {
	if (!existsSync(resolve(root, relative))) {
		problems.push(`${relative}: missing required Phase 4 operator module`);
	}
}
for (const relative of customerRoots) {
	for (const file of filesUnder(relative)) {
		if (!/\.(?:ts|tsx|js|jsx)$/.test(file)) continue;
		const source = readFileSync(file, "utf8");
		for (const pattern of infrastructureWords) {
			if (pattern.test(source)) {
				problems.push(
					`${file.slice(root.length + 1)}: customer surface contains infrastructure terminology ${pattern}`,
				);
			}
		}
	}
}
const rootSource = readFileSync(
	resolve(root, "apps/dokploy/server/api/root.ts"),
	"utf8",
);
if (!rootSource.includes("infrastructure: infrastructureRouter")) {
	problems.push("operator infrastructure router is not registered");
}
const trpcSource = readFileSync(
	resolve(root, "apps/dokploy/server/api/trpc.ts"),
	"utf8",
);
if (!trpcSource.includes("superadminProcedure")) {
	problems.push("separate superadmin browser audience is missing");
}
const operatorAuth = readFileSync(
	resolve(root, "apps/dokploy/server/operator-auth.ts"),
	"utf8",
);
for (const required of [
	"__Host-deploytide_operator_session",
	"DEPLOYTIDE_OPERATOR_ORIGIN",
	"x-deploytide-operator-csrf",
	"sec-fetch-site",
]) {
	if (!operatorAuth.includes(required)) {
		problems.push(`operator browser hardening is missing ${required}`);
	}
}
const operatorClient = readFileSync(
	resolve(root, "apps/dokploy/utils/api.ts"),
	"utf8",
);
if (
	!operatorClient.includes("operatorApi") ||
	!operatorClient.includes("/api/operator/csrf")
) {
	problems.push("dedicated CSRF-bound operator API client is missing");
}
const controllerAuth = readFileSync(
	resolve(root, "apps/dokploy/server/controller-auth.ts"),
	"utf8",
);
if (!controllerAuth.includes("x-deploytide-client-fingerprint")) {
	problems.push("controller certificate fingerprint authentication is missing");
}
if (!controllerAuth.includes("x-deploytide-runtime-target")) {
	problems.push("controller runtime target authentication is missing");
}
const secretReferences = readFileSync(
	resolve(root, "packages/server/src/infrastructure/secret-reference.ts"),
	"utf8",
);
for (const required of [
	"DEPLOYTIDE_OPERATOR_SECRET_REFERENCES",
	"DEPLOYTIDE_OPERATOR_SECRET_FILE_ROOTS",
	"assertOperatorSecretId",
]) {
	if (!secretReferences.includes(required)) {
		problems.push(`opaque provider secret controls are missing ${required}`);
	}
}
const infrastructureRouterSource = readFileSync(
	resolve(root, "apps/dokploy/server/api/routers/infrastructure.ts"),
	"utf8",
);
for (const forbidden of [
	"secretReference:",
	"certificatePem:",
	"privateKeyReference:",
]) {
	if (infrastructureRouterSource.includes(forbidden)) {
		problems.push(
			`operator router accepts forbidden browser field ${forbidden}`,
		);
	}
}
for (const route of ["server", "ssh-key", "docker", "cluster", "swarm"]) {
	const source = readFileSync(
		resolve(root, `apps/dokploy/server/api/routers/${route}.ts`),
		"utf8",
	);
	if (!source.includes("operatorProcedure")) {
		problems.push(`${route} compatibility router is not operator-only`);
	}
}
const contracts = readFileSync(
	resolve(root, "packages/server/src/infrastructure/contracts.ts"),
	"utf8",
);
for (const contract of [
	"InfrastructureProvider",
	"BuildProvider",
	"RuntimeProvider",
	"RegistryProvider",
	"EdgeProvider",
	"TelemetryProvider",
]) {
	if (!contracts.includes(`interface ${contract}`)) {
		problems.push(`missing provider contract ${contract}`);
	}
}
if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}
console.log(
	"Infrastructure boundaries verified: six provider contracts, separate operator audience, and no customer infrastructure terminology.",
);
