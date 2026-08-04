import type { RepositoryEvidence } from "./types";

const ROOT_MARKER_FILES = [
	"package.json",
	"Dockerfile",
	"go.mod",
	"requirements.txt",
	"pyproject.toml",
	"Gemfile",
	"composer.json",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
];

const EXCLUDED_SEGMENTS = new Set([
	"node_modules",
	".git",
	"vendor",
	"dist",
	"build",
	".next",
	".turbo",
	"target",
]);

const isExcluded = (relativeDirectory: string): boolean =>
	relativeDirectory
		.split("/")
		.some((segment) => EXCLUDED_SEGMENTS.has(segment));

/**
 * Finds candidate application roots within a single repository tree: the
 * repository root itself (if it has any marker file) plus any nested
 * directory containing its own marker file, excluding dependency/build
 * output directories. Each candidate becomes an independently importable
 * project per the monorepo import model.
 */
export const findMonorepoRootCandidates = (
	evidence: RepositoryEvidence,
): string[] => {
	const candidates = new Set<string>();
	for (const file of evidence.files) {
		const lastSlash = file.lastIndexOf("/");
		const directory = lastSlash === -1 ? "" : file.slice(0, lastSlash);
		const fileName = lastSlash === -1 ? file : file.slice(lastSlash + 1);
		if (!ROOT_MARKER_FILES.includes(fileName)) continue;
		if (directory && isExcluded(directory)) continue;
		candidates.add(directory);
	}
	return [...candidates].sort((left, right) => {
		// Shallower roots (fewer path segments) sort first; the repository
		// root ("") always sorts before any nested root.
		const leftDepth = left ? left.split("/").length : 0;
		const rightDepth = right ? right.split("/").length : 0;
		if (leftDepth !== rightDepth) return leftDepth - rightDepth;
		return left.localeCompare(right);
	});
};

/**
 * Restricts evidence to only the files/manifests that live under the given
 * root (or the whole repository when root is empty), rewriting paths to be
 * relative to that root so detectors can run unmodified against a subtree.
 */
export const scopeEvidenceToRoot = (
	evidence: RepositoryEvidence,
	root: string,
): RepositoryEvidence => {
	if (!root) return evidence;
	const prefix = `${root}/`;
	const files = new Set<string>();
	for (const file of evidence.files) {
		if (file.startsWith(prefix)) files.add(file.slice(prefix.length));
	}
	const manifests = new Map<string, string>();
	for (const [path, contents] of evidence.manifests) {
		if (path.startsWith(prefix)) manifests.set(path.slice(prefix.length), contents);
	}
	return { files, manifests };
};
