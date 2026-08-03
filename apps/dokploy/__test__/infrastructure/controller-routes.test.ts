import { TRPCError } from "@trpc/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	AuthError: class ControllerAuthenticationError extends Error {},
	acknowledge: vi.fn(),
	authorize: vi.fn(),
	complete: vi.fn(),
	heartbeat: vi.fn(),
	next: vi.fn(),
	readPrivateKey: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	acknowledgeControllerJob: mocks.acknowledge,
	completeControllerJob: mocks.complete,
	getNextSignedControllerJob: mocks.next,
	heartbeatRuntimeController: mocks.heartbeat,
}));

vi.mock("@/server/controller-auth", () => ({
	authorizeRuntimeControllerRequest: mocks.authorize,
	ControllerAuthenticationError: mocks.AuthError,
	controllerNoStore: { "Cache-Control": "no-store" },
	CONTROLLER_RUNTIME_TARGET_HEADER: "x-deploytide-runtime-target",
	isControllerIdentifier: (value: unknown) =>
		typeof value === "string" &&
		/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,191}$/.test(value),
	readControllerSigningPrivateKey: mocks.readPrivateKey,
}));

import heartbeatHandler from "@/pages/api/operator/controllers/[clusterId]/heartbeat";
import acknowledgementHandler from "@/pages/api/operator/controllers/[clusterId]/jobs/[attemptId]/ack";
import resultHandler from "@/pages/api/operator/controllers/[clusterId]/jobs/[attemptId]/result";
import jobsHandler from "@/pages/api/operator/controllers/[clusterId]/jobs/index";

const response = () => {
	const res = {
		end: vi.fn(),
		json: vi.fn(),
		setHeader: vi.fn(),
		status: vi.fn(),
	} as unknown as NextApiResponse & {
		end: ReturnType<typeof vi.fn>;
		json: ReturnType<typeof vi.fn>;
		setHeader: ReturnType<typeof vi.fn>;
		status: ReturnType<typeof vi.fn>;
	};
	res.status.mockImplementation(() => res);
	res.json.mockImplementation(() => res);
	res.end.mockImplementation(() => res);
	return res;
};

const request = (input: {
	method?: string;
	query?: Record<string, string | string[]>;
	body?: unknown;
	headers?: Record<string, string | string[] | undefined>;
}) =>
	({
		method: input.method ?? "POST",
		query: input.query ?? {
			clusterId: "cluster-a",
			attemptId: "attempt-a",
		},
		body: input.body,
		headers: {
			"content-type": "application/json",
			"x-deploytide-runtime-target": "target-exact",
			...input.headers,
		},
	}) as unknown as NextApiRequest;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.authorize.mockResolvedValue(undefined);
	mocks.readPrivateKey.mockResolvedValue("private-key");
	mocks.next.mockResolvedValue(null);
});

describe("runtime controller HTTP protocol", () => {
	it("rejects partial sequence parsing and unknown poll query fields", async () => {
		const queries: Array<Record<string, string | string[]>> = [
			{ clusterId: "cluster-a", afterSequence: "1junk" },
			{ clusterId: "cluster-a", afterSequence: "1", unknown: "field" },
		];
		for (const query of queries) {
			const res = response();
			await jobsHandler(request({ method: "GET", query }), res);
			expect(res.status).toHaveBeenCalledWith(400);
		}
		expect(mocks.authorize).not.toHaveBeenCalled();
	});

	it("requires one protected runtime target header", async () => {
		for (const runtimeTargetId of [
			undefined,
			"",
			"target/escape",
			"a".repeat(193),
			["target-a", "target-b"],
		]) {
			const res = response();
			await jobsHandler(
				request({
					method: "GET",
					query: { clusterId: "cluster-a" },
					headers: { "x-deploytide-runtime-target": runtimeTargetId },
				}),
				res,
			);
			expect(res.status).toHaveBeenCalledWith(400);
		}
		expect(mocks.authorize).not.toHaveBeenCalled();
		expect(mocks.next).not.toHaveBeenCalled();
	});

	it("scopes polling and acknowledgement to the exact runtime target", async () => {
		const pollRequest = request({
			method: "GET",
			query: { clusterId: "cluster-a", afterSequence: "4" },
		});
		const pollResponse = response();
		await jobsHandler(pollRequest, pollResponse);
		expect(mocks.authorize).toHaveBeenCalledWith(
			pollRequest,
			"cluster-a",
			"target-exact",
		);
		expect(mocks.next).toHaveBeenCalledWith({
			runtimeClusterId: "cluster-a",
			runtimeTargetId: "target-exact",
			afterSequence: 4,
			privateKeyPem: "private-key",
		});

		const acknowledgementRequest = request({ body: { fencingToken: 7 } });
		const acknowledgementResponse = response();
		await acknowledgementHandler(
			acknowledgementRequest,
			acknowledgementResponse,
		);
		expect(mocks.authorize).toHaveBeenCalledWith(
			acknowledgementRequest,
			"cluster-a",
			"target-exact",
		);
		expect(mocks.acknowledge).toHaveBeenCalledWith({
			operatorJobAttemptId: "attempt-a",
			runtimeClusterId: "cluster-a",
			runtimeTargetId: "target-exact",
			fencingToken: 7,
		});
	});

	it("rejects numeric coercion and unknown acknowledgement fields", async () => {
		for (const body of [
			{ fencingToken: "7" },
			{ fencingToken: 7, command: "whoami" },
		]) {
			const res = response();
			await acknowledgementHandler(request({ body }), res);
			expect(res.status).toHaveBeenCalledWith(400);
		}
		expect(mocks.acknowledge).not.toHaveBeenCalled();
	});

	it("accepts only the typed result shape", async () => {
		const invalid = response();
		await resultHandler(
			request({
				body: {
					fencingToken: 7,
					result: {
						succeeded: false,
						retryable: false,
						command: "sh -c id",
					},
				},
			}),
			invalid,
		);
		expect(invalid.status).toHaveBeenCalledWith(400);
		expect(mocks.complete).not.toHaveBeenCalled();

		const valid = response();
		await resultHandler(
			request({
				body: {
					fencingToken: 7,
					result: {
						succeeded: false,
						retryable: true,
						diagnostics: "engine unavailable",
					},
				},
			}),
			valid,
		);
		expect(mocks.complete).toHaveBeenCalledWith({
			operatorJobAttemptId: "attempt-a",
			runtimeClusterId: "cluster-a",
			runtimeTargetId: "target-exact",
			fencingToken: 7,
			succeeded: false,
			result: undefined,
			retryable: true,
			diagnostics: "[redacted controller diagnostics]",
		});
		expect(valid.status).toHaveBeenCalledWith(204);
	});

	it("redacts secret-like result values before persistence", async () => {
		const res = response();
		await resultHandler(
			request({
				body: {
					fencingToken: 7,
					result: {
						succeeded: true,
						retryable: false,
						result: {
							message: "Authorization: Bearer private-value",
						},
						diagnostics: "token=private-value",
					},
				},
			}),
			res,
		);
		expect(mocks.complete).toHaveBeenCalledWith(
			expect.objectContaining({
				result: { message: "[redacted]" },
				diagnostics: "[redacted controller diagnostics]",
			}),
		);
	});

	it("preserves typed non-secret controller result strings", async () => {
		const res = response();
		await resultHandler(
			request({
				body: {
					fencingToken: 7,
					result: {
						succeeded: true,
						retryable: false,
						result: {
							runtimePlacementReference: "placement-a",
							imageDigest: `sha256:${"a".repeat(64)}`,
						},
					},
				},
			}),
			res,
		);
		expect(mocks.complete).toHaveBeenCalledWith(
			expect.objectContaining({
				result: {
					runtimePlacementReference: "placement-a",
					imageDigest: `sha256:${"a".repeat(64)}`,
				},
			}),
		);
	});

	it("requires and forwards the exact runtime target identity", async () => {
		const missing = response();
		await heartbeatHandler(
			request({ body: { version: "1.0.0", health: "healthy" } }),
			missing,
		);
		expect(missing.status).toHaveBeenCalledWith(400);
		expect(mocks.heartbeat).not.toHaveBeenCalled();

		const mismatch = response();
		await heartbeatHandler(
			request({
				query: { clusterId: "cluster-a" },
				body: {
					runtimeTargetId: "target-sibling",
					version: "1.0.0",
					health: "healthy",
				},
			}),
			mismatch,
		);
		expect(mismatch.status).toHaveBeenCalledWith(400);
		expect(mocks.authorize).not.toHaveBeenCalled();
		expect(mocks.heartbeat).not.toHaveBeenCalled();

		const valid = response();
		await heartbeatHandler(
			request({
				query: { clusterId: "cluster-a" },
				body: {
					runtimeTargetId: "target-exact",
					version: "1.0.0",
					health: "degraded",
				},
			}),
			valid,
		);
		expect(mocks.heartbeat).toHaveBeenCalledWith({
			runtimeClusterId: "cluster-a",
			runtimeTargetId: "target-exact",
			controllerVersion: "1.0.0",
			health: "degraded",
		});
		expect(valid.status).toHaveBeenCalledWith(204);
	});

	it("distinguishes authentication failure from state conflict", async () => {
		mocks.authorize.mockRejectedValueOnce(new mocks.AuthError());
		const unauthorized = response();
		await acknowledgementHandler(
			request({ body: { fencingToken: 7 } }),
			unauthorized,
		);
		expect(unauthorized.status).toHaveBeenCalledWith(401);

		mocks.authorize.mockResolvedValueOnce(undefined);
		mocks.acknowledge.mockRejectedValueOnce(
			new TRPCError({ code: "CONFLICT" }),
		);
		const conflict = response();
		await acknowledgementHandler(
			request({ body: { fencingToken: 7 } }),
			conflict,
		);
		expect(conflict.status).toHaveBeenCalledWith(409);
	});
});
