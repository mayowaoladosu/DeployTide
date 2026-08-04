import type { RepositoryEvidence } from "./types";

export const hasFile = (evidence: RepositoryEvidence, path: string): boolean =>
	evidence.files.has(path);

export const hasAnyFile = (
	evidence: RepositoryEvidence,
	paths: readonly string[],
): boolean => paths.some((path) => evidence.files.has(path));

export const manifestText = (
	evidence: RepositoryEvidence,
	path: string,
): string | undefined => evidence.manifests.get(path);

interface PackageJsonShape {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
}

export const parsePackageJson = (
	evidence: RepositoryEvidence,
	path = "package.json",
): PackageJsonShape | null => {
	const text = manifestText(evidence, path);
	if (!text) return null;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		return parsed as PackageJsonShape;
	} catch {
		return null;
	}
};

export const hasDependency = (
	pkg: PackageJsonShape | null,
	name: string,
): boolean =>
	Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);

export const detectNodePackageManager = (
	evidence: RepositoryEvidence,
): "npm" | "pnpm" | "yarn" | "bun" => {
	if (hasFile(evidence, "bun.lockb") || hasFile(evidence, "bun.lock")) {
		return "bun";
	}
	if (hasFile(evidence, "pnpm-lock.yaml")) return "pnpm";
	if (hasFile(evidence, "yarn.lock")) return "yarn";
	return "npm";
};

export const nodeInstallCommand = (
	packageManager: "npm" | "pnpm" | "yarn" | "bun",
): string => {
	switch (packageManager) {
		case "bun":
			return "bun install";
		case "pnpm":
			return "pnpm install --frozen-lockfile";
		case "yarn":
			return "yarn install --frozen-lockfile";
		default:
			return "npm ci";
	}
};

export const nodeRunCommand = (
	packageManager: "npm" | "pnpm" | "yarn" | "bun",
	script: string,
): string => {
	switch (packageManager) {
		case "bun":
			return `bun run ${script}`;
		case "pnpm":
			return `pnpm run ${script}`;
		case "yarn":
			return `yarn ${script}`;
		default:
			return `npm run ${script}`;
	}
};
