import {
	detectNodePackageManager,
	hasDependency,
	hasFile,
	nodeInstallCommand,
	nodeRunCommand,
	parsePackageJson,
} from "../evidence";
import type { FrameworkDetectionResult, FrameworkDetector } from "../types";

const nodeManifestPresets: Array<{
	id: string;
	label: string;
	dependency: string;
	buildScript?: string;
	startScript?: string;
	outputDirectory?: string;
	port?: number;
	evidenceFile: string;
}> = [
	{
		id: "nextjs",
		label: "Next.js",
		dependency: "next",
		buildScript: "build",
		startScript: "start",
		port: 3000,
		evidenceFile: "package.json (next dependency)",
	},
	{
		id: "remix",
		label: "Remix",
		dependency: "@remix-run/dev",
		buildScript: "build",
		startScript: "start",
		port: 3000,
		evidenceFile: "package.json (@remix-run/dev dependency)",
	},
	{
		id: "nuxt",
		label: "Nuxt",
		dependency: "nuxt",
		buildScript: "build",
		startScript: "start",
		port: 3000,
		evidenceFile: "package.json (nuxt dependency)",
	},
	{
		id: "sveltekit",
		label: "SvelteKit",
		dependency: "@sveltejs/kit",
		buildScript: "build",
		startScript: "preview",
		port: 4173,
		evidenceFile: "package.json (@sveltejs/kit dependency)",
	},
	{
		id: "astro",
		label: "Astro",
		dependency: "astro",
		buildScript: "build",
		outputDirectory: "dist",
		evidenceFile: "package.json (astro dependency)",
	},
	{
		id: "angular",
		label: "Angular",
		dependency: "@angular/core",
		buildScript: "build",
		outputDirectory: "dist",
		evidenceFile: "package.json (@angular/core dependency)",
	},
	{
		id: "vite",
		label: "Vite",
		dependency: "vite",
		buildScript: "build",
		outputDirectory: "dist",
		evidenceFile: "package.json (vite dependency)",
	},
];

/** Server-rendered/full frameworks that boot a Node process rather than serving static output. */
const serverPresets = new Set(["nextjs", "remix", "nuxt", "sveltekit"]);

export const nodeFrameworkDetector: FrameworkDetector = {
	id: "node-framework",
	detect(evidence): FrameworkDetectionResult | null {
		const pkg = parsePackageJson(evidence);
		if (!pkg) return null;
		const preset = nodeManifestPresets.find((candidate) =>
			hasDependency(pkg, candidate.dependency),
		);
		if (!preset) return null;
		const packageManager = detectNodePackageManager(evidence);
		const isServer = serverPresets.has(preset.id);
		return {
			preset: preset.id,
			label: preset.label,
			confidence: 0.95,
			buildType: isServer ? "railpack" : "static",
			packageManager,
			installCommand: nodeInstallCommand(packageManager),
			buildCommand: preset.buildScript
				? nodeRunCommand(packageManager, preset.buildScript)
				: undefined,
			startCommand:
				isServer && preset.startScript
					? nodeRunCommand(packageManager, preset.startScript)
					: undefined,
			outputDirectory: isServer ? undefined : preset.outputDirectory,
			port: preset.port,
			evidence: [{ message: `Detected via ${preset.evidenceFile}` }],
			warnings: [],
		};
	},
};

export const nodeServerDetector: FrameworkDetector = {
	id: "node-server",
	detect(evidence): FrameworkDetectionResult | null {
		const pkg = parsePackageJson(evidence);
		if (!pkg) return null;
		const startScript = pkg.scripts?.start;
		if (!startScript) return null;
		const packageManager = detectNodePackageManager(evidence);
		return {
			preset: "node-server",
			label: "Node.js server",
			confidence: 0.55,
			buildType: "railpack",
			packageManager,
			installCommand: nodeInstallCommand(packageManager),
			buildCommand: pkg.scripts?.build
				? nodeRunCommand(packageManager, "build")
				: undefined,
			startCommand: nodeRunCommand(packageManager, "start"),
			port: 3000,
			evidence: [{ message: "Detected via package.json scripts.start" }],
			warnings: [],
		};
	},
};

export const staticSiteDetector: FrameworkDetector = {
	id: "static-site",
	detect(evidence): FrameworkDetectionResult | null {
		if (parsePackageJson(evidence)) return null;
		if (!hasFile(evidence, "index.html")) return null;
		return {
			preset: "static",
			label: "Static site",
			confidence: 0.4,
			buildType: "static",
			packageManager: "unknown",
			outputDirectory: "",
			evidence: [{ message: "Detected via root index.html" }],
			warnings: [],
		};
	},
};
