import { publicRepositoryReference } from "@dokploy/server/services/deployment";
import { assertWorkspaceResource } from "@dokploy/server/services/tenancy";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";

describe("canonical workspace ownership", () => {
	it("returns a resource owned by the active workspace", () => {
		const resource = { organizationId: "org-a", id: "project-a" };
		expect(assertWorkspaceResource("org-a", resource, "Project")).toBe(
			resource,
		);
	});

	it("uses NOT_FOUND for cross-workspace identifiers", () => {
		const error = (() => {
			try {
				assertWorkspaceResource(
					"org-a",
					{ organizationId: "org-b", id: "project-b" },
					"Project",
				);
			} catch (caught) {
				return caught;
			}
		})();
		expect(error).toBeInstanceOf(TRPCError);
		expect(error).toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects legacy resources that have not been backfilled", () => {
		expect(() =>
			assertWorkspaceResource(
				"org-a",
				{ organizationId: null, id: "legacy" },
				"Deployment",
			),
		).toThrow("Deployment not found");
	});

	it("removes URL credentials from canonical repository snapshots", () => {
		expect(
			publicRepositoryReference("https://deploy-user:secret@example.test/repo.git"),
		).toBe("https://example.test/repo.git");
		expect(
			publicRepositoryReference(
				"https://example.test/repo.git?access_token=secret#credential",
			),
		).toBe("https://example.test/repo.git");
		expect(publicRepositoryReference("git@example.test:repo.git")).toBe(
			"git@example.test:repo.git",
		);
	});
});
