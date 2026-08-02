import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import process from "node:process";

const root = process.cwd();
const skippedDirectories = new Set([
	".git",
	".next",
	"coverage",
	"dist",
	"node_modules",
	"playwright-report",
	"test-results",
]);
const sourceExtensions = new Set([
	".cjs",
	".cts",
	".js",
	".jsx",
	".mjs",
	".mts",
	".ts",
	".tsx",
]);
const proprietaryImport =
	/(?:from\s*|import\s*\(|require\s*\()\s*["'][^"']*(?:^|\/)proprietary(?:\/|["'])/gm;
const forbiddenPackages = new Set(["@better-auth/scim", "@better-auth/sso"]);
const violations = [];

async function walk(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
		const absolutePath = join(directory, entry.name);
		const repoPath = relative(root, absolutePath).split(sep).join("/");

		if (entry.isDirectory()) {
			if (entry.name.toLowerCase() === "proprietary") {
				violations.push(`${repoPath}: proprietary source directory is forbidden`);
				continue;
			}
			await walk(absolutePath);
			continue;
		}

		if (!entry.isFile()) continue;
		if (entry.name === "LICENSE_PROPRIETARY.md") {
			violations.push(`${repoPath}: DSAL license file must not ship`);
		}
		if (sourceExtensions.has(extname(entry.name))) {
			const source = await readFile(absolutePath, "utf8");
			if (proprietaryImport.test(source)) {
				violations.push(`${repoPath}: imports a proprietary source path`);
			}
			proprietaryImport.lastIndex = 0;
		}
		if (entry.name === "package.json") {
			const manifest = JSON.parse(await readFile(absolutePath, "utf8"));
			for (const section of [
				"dependencies",
				"devDependencies",
				"optionalDependencies",
				"peerDependencies",
			]) {
				for (const packageName of Object.keys(manifest[section] ?? {})) {
					if (forbiddenPackages.has(packageName)) {
						violations.push(
							`${repoPath}: ${packageName} remains in ${section}`,
						);
					}
				}
			}
		}
	}
}

await walk(root);

for (const requiredPath of ["LICENSE.MD", "NOTICE"]) {
	try {
		if (!(await stat(join(root, requiredPath))).isFile()) {
			violations.push(`${requiredPath}: required licensing file is missing`);
		}
	} catch {
		violations.push(`${requiredPath}: required licensing file is missing`);
	}
}

if (violations.length > 0) {
	console.error("License-boundary violations:\n");
	for (const violation of violations) console.error(`- ${violation}`);
	process.exit(1);
}

console.log("License boundaries verified: Apache-only source tree.");
