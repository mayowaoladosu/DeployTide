import { assertVariableScope } from "@dokploy/server/services/secrets";
import { describe, expect, it } from "vitest";

describe("canonical variable scopes", () => {
	it.each([
		{ scope: "workspace" as const },
		{ scope: "project" as const, projectId: "project-a" },
		{
			scope: "environment" as const,
			projectId: "project-a",
			environmentId: "environment-a",
		},
	])("accepts a valid $scope scope", (input) => {
		expect(() => assertVariableScope(input)).not.toThrow();
	});

	it.each([
		{ scope: "workspace" as const, projectId: "project-a" },
		{ scope: "project" as const },
		{
			scope: "project" as const,
			projectId: "project-a",
			environmentId: "environment-a",
		},
		{ scope: "environment" as const, projectId: "project-a" },
	])("rejects an invalid $scope target", (input) => {
		expect(() => assertVariableScope(input)).toThrow(/scope/);
	});
});
