import { describe, expect, it } from "vitest";
import {
	findMonorepoRootCandidates,
	scopeEvidenceToRoot,
} from "@dokploy/server/frameworks";
import type { RepositoryEvidence } from "@dokploy/server/frameworks";

const evidence = (files: string[]): RepositoryEvidence => ({
	files: new Set(files),
	manifests: new Map(),
});

describe("findMonorepoRootCandidates", () => {
	it("returns the repository root when it has a marker file", () => {
		const roots = findMonorepoRootCandidates(evidence(["package.json"]));
		expect(roots).toEqual([""]);
	});

	it("finds nested app roots in a monorepo", () => {
		const roots = findMonorepoRootCandidates(
			evidence([
				"package.json",
				"apps/web/package.json",
				"apps/api/go.mod",
				"packages/shared/package.json",
			]),
		);
		expect(roots).toContain("");
		expect(roots).toContain("apps/web");
		expect(roots).toContain("apps/api");
		expect(roots).toContain("packages/shared");
	});

	it("excludes marker files under dependency/build directories", () => {
		const roots = findMonorepoRootCandidates(
			evidence([
				"package.json",
				"apps/web/node_modules/some-lib/package.json",
				"apps/web/dist/package.json",
			]),
		);
		expect(roots).toEqual([""]);
	});

	it("sorts shallower roots before deeper ones", () => {
		const roots = findMonorepoRootCandidates(
			evidence([
				"services/api/nested/deep/package.json",
				"apps/web/package.json",
				"package.json",
			]),
		);
		expect(roots[0]).toBe("");
		expect(roots.at(-1)).toBe("services/api/nested/deep");
	});

	it("returns no candidates when nothing matches", () => {
		const roots = findMonorepoRootCandidates(evidence(["README.md"]));
		expect(roots).toEqual([]);
	});
});

describe("scopeEvidenceToRoot", () => {
	it("returns evidence unchanged for an empty root", () => {
		const source = evidence(["package.json", "apps/web/package.json"]);
		expect(scopeEvidenceToRoot(source, "")).toBe(source);
	});

	it("rewrites file paths relative to the given root", () => {
		const source: RepositoryEvidence = {
			files: new Set(["apps/web/package.json", "apps/web/src/index.ts", "apps/api/go.mod"]),
			manifests: new Map([["apps/web/package.json", "{}"]]),
		};
		const scoped = scopeEvidenceToRoot(source, "apps/web");
		expect([...scoped.files].sort()).toEqual(["package.json", "src/index.ts"]);
		expect(scoped.manifests.get("package.json")).toBe("{}");
	});

	it("excludes files outside the given root", () => {
		const source = evidence(["apps/web/package.json", "apps/api/go.mod"]);
		const scoped = scopeEvidenceToRoot(source, "apps/web");
		expect(scoped.files.has("go.mod")).toBe(false);
	});
});
