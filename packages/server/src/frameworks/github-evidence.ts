import type { Octokit } from "octokit";
import { findMonorepoRootCandidates } from "./monorepo";
import type { RepositoryEvidence } from "./types";

/** Hard bounds so a single import can never make the detector do unbounded work. */
export const MAX_TREE_ENTRIES = 20_000;
export const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
export const MAX_MANIFEST_FETCHES = 64;
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 500;

/** Directories excluded from the tree scan entirely; matching Dockerfiles/manifests inside them are ignored. */
const EXCLUDED_PATH_SEGMENTS = new Set([
	"node_modules",
	".git",
	"vendor",
	"dist",
	"build",
	".next",
	".turbo",
	"target",
]);

const isExcludedPath = (path: string): boolean =>
	path.split("/").some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment));

/** Manifest file names whose contents a detector may need to read. */
const MANIFEST_FILE_NAMES = new Set([
	"package.json",
	"requirements.txt",
	"pyproject.toml",
	"Pipfile",
	"composer.json",
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimitStatus = (status: unknown): boolean =>
	status === 403 || status === 429;

async function withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
	let attempt = 0;
	for (;;) {
		try {
			return await operation();
		} catch (error) {
			const status = (error as { status?: number } | undefined)?.status;
			if (!isRateLimitStatus(status) || attempt >= RATE_LIMIT_MAX_RETRIES) {
				throw error;
			}
			attempt += 1;
			await sleep(RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1));
		}
	}
}

interface FetchEvidenceInput {
	octokit: Octokit;
	owner: string;
	repo: string;
	/** Branch or ref to scan; defaults to the repository's default branch. */
	ref?: string;
	/** Overall time budget; the adapter degrades to whatever evidence it gathered before this elapses. */
	timeoutMs?: number;
}

/**
 * Builds bounded repository evidence for framework detection from a real
 * GitHub repository: a single recursive tree listing, filtered to a size
 * cap and excluded directories, followed by bounded manifest-content reads
 * for the repository root and any detected monorepo root candidates.
 *
 * Never throws for ordinary GitHub failures (rate limits after retry,
 * oversized trees, missing files); returns the best-effort evidence
 * gathered so far so the caller can fall back to manual configuration.
 */
export const buildRepositoryEvidenceFromGithub = async (
	input: FetchEvidenceInput,
): Promise<RepositoryEvidence> => {
	const { octokit, owner, repo } = input;
	const timeoutMs = input.timeoutMs ?? 20_000;
	const deadline = Date.now() + timeoutMs;

	const files = new Set<string>();
	const manifests = new Map<string, string>();

	let ref = input.ref;
	if (!ref) {
		try {
			const repository = await withRateLimitRetry(() =>
				octokit.rest.repos.get({ owner, repo }),
			);
			ref = repository.data.default_branch;
		} catch {
			return { files, manifests };
		}
	}

	let treeSha: string;
	try {
		const branch = await withRateLimitRetry(() =>
			octokit.rest.repos.getBranch({ owner, repo, branch: ref as string }),
		);
		treeSha = branch.data.commit.sha;
	} catch {
		return { files, manifests };
	}

	try {
		const tree = await withRateLimitRetry(() =>
			octokit.rest.git.getTree({ owner, repo, tree_sha: treeSha, recursive: "1" }),
		);
		let scanned = 0;
		for (const entry of tree.data.tree) {
			if (scanned >= MAX_TREE_ENTRIES) break;
			if (entry.type !== "blob" || !entry.path) continue;
			if (isExcludedPath(entry.path)) continue;
			files.add(entry.path);
			scanned += 1;
			if (Date.now() > deadline) break;
		}
	} catch {
		return { files, manifests };
	}

	const roots = findMonorepoRootCandidates({ files, manifests: new Map() });
	const manifestTargets: string[] = [];
	for (const root of roots.length > 0 ? roots : [""]) {
		for (const name of MANIFEST_FILE_NAMES) {
			const path = root ? `${root}/${name}` : name;
			if (files.has(path)) manifestTargets.push(path);
		}
		if (manifestTargets.length >= MAX_MANIFEST_FETCHES) break;
	}

	for (const path of manifestTargets.slice(0, MAX_MANIFEST_FETCHES)) {
		if (Date.now() > deadline) break;
		try {
			const content = await withRateLimitRetry(() =>
				octokit.rest.repos.getContent({ owner, repo, path, ref }),
			);
			const data = content.data;
			if (
				Array.isArray(data) ||
				data.type !== "file" ||
				typeof data.content !== "string"
			) {
				continue;
			}
			if (data.size > MAX_MANIFEST_BYTES) continue;
			manifests.set(path, Buffer.from(data.content, "base64").toString("utf8"));
		} catch {
			// A single unreadable manifest degrades that file's detection only.
		}
	}

	return { files, manifests };
};
