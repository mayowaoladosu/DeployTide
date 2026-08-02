import { TRPCError } from "@trpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOperatorRequest } from "@/server/api/trpc";

const request = (token?: string) =>
	({
		headers: token ? { "x-deploytide-operator-token": token } : {},
	}) as Parameters<typeof assertOperatorRequest>[0];

describe("operator infrastructure boundary", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("rejects a normal customer request without an operator credential", () => {
		vi.stubEnv("DEPLOYTIDE_OPERATOR_API_TOKEN", "operator-only-secret");
		expect(() => assertOperatorRequest(request())).toThrowError(
			expect.objectContaining<Partial<TRPCError>>({ code: "UNAUTHORIZED" }),
		);
	});

	it("rejects an incorrect operator credential", () => {
		vi.stubEnv("DEPLOYTIDE_OPERATOR_API_TOKEN", "operator-only-secret");
		expect(() => assertOperatorRequest(request("customer-session-token"))).toThrow(
			TRPCError,
		);
	});

	it("accepts the independent operator credential", () => {
		vi.stubEnv("DEPLOYTIDE_OPERATOR_API_TOKEN", "operator-only-secret");
		expect(() =>
			assertOperatorRequest(request("operator-only-secret")),
		).not.toThrow();
	});
});
