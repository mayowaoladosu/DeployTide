import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	audit: vi.fn(),
	validate: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({ recordOperatorAudit: mocks.audit }));
vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: mocks.validate,
}));

import sessionHandler from "@/pages/api/operator/session";
import {
	createOperatorSessionToken,
	operatorSessionCookieName,
} from "@/server/operator-auth";

const email = "operator-route@deploytide.test";
const userId = "operator-route-user";

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
	method: "POST" | "DELETE";
	headers?: Record<string, string>;
	body?: unknown;
}) =>
	({
		method: input.method,
		headers: input.headers ?? {},
		body: input.body,
		socket: { remoteAddress: "127.0.0.2" },
	}) as unknown as NextApiRequest;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.validate.mockResolvedValue({ user: { id: userId, email } });
	mocks.audit.mockResolvedValue({ operatorAuditLogId: "audit" });
	vi.stubEnv("DEPLOYTIDE_OPERATOR_API_TOKEN", "operator-route-token");
	vi.stubEnv(
		"DEPLOYTIDE_OPERATOR_SESSION_SECRET",
		"operator-route-session-secret-longer-than-32-bytes",
	);
	vi.stubEnv("DEPLOYTIDE_SUPERADMIN_EMAILS", email);
	vi.stubEnv("DEPLOYTIDE_OPERATOR_ORIGIN", "https://operator.deploytide.test");
});

afterEach(() => vi.unstubAllEnvs());

describe("operator session HTTP route", () => {
	it("rejects sibling-site exchange and mints only after auditing exact-origin JSON", async () => {
		const sibling = response();
		await sessionHandler(
			request({
				method: "POST",
				headers: {
					origin: "https://sibling.deploytide.test",
					"sec-fetch-site": "same-site",
					"content-type": "application/json",
					"user-agent": "route-test",
				},
				body: { accessToken: "operator-route-token" },
			}),
			sibling,
		);
		expect(sibling.status).toHaveBeenCalledWith(403);
		expect(mocks.audit).not.toHaveBeenCalled();

		const valid = response();
		await sessionHandler(
			request({
				method: "POST",
				headers: {
					origin: "https://operator.deploytide.test",
					"sec-fetch-site": "same-origin",
					"content-type": "application/json",
					"user-agent": "route-test",
				},
				body: { accessToken: "operator-route-token" },
			}),
			valid,
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "mint",
				resourceType: "operatorSession",
			}),
		);
		expect(valid.setHeader).toHaveBeenCalledWith(
			"Set-Cookie",
			expect.any(Array),
		);
		expect(valid.status).toHaveBeenCalledWith(204);
	});

	it("does not allow blind cross-site logout", async () => {
		const token = createOperatorSessionToken({
			userId,
			email,
			req: request({
				method: "POST",
				headers: { "user-agent": "route-test" },
			}),
		});
		const csrf = (
			JSON.parse(
				Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
			) as { csrf: string }
		).csrf;
		const cookie = `${operatorSessionCookieName}=${encodeURIComponent(token)}`;
		const blind = response();
		await sessionHandler(
			request({
				method: "DELETE",
				headers: { cookie, "user-agent": "route-test" },
			}),
			blind,
		);
		expect(blind.status).toHaveBeenCalledWith(403);
		expect(blind.setHeader).not.toHaveBeenCalledWith(
			"Set-Cookie",
			expect.anything(),
		);

		const valid = response();
		await sessionHandler(
			request({
				method: "DELETE",
				headers: {
					cookie,
					"user-agent": "route-test",
					origin: "https://operator.deploytide.test",
					"sec-fetch-site": "same-origin",
					"content-type": "application/json",
					"x-deploytide-operator-csrf": csrf,
				},
				body: {},
			}),
			valid,
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "logout",
				resourceType: "operatorSession",
			}),
		);
		expect(valid.status).toHaveBeenCalledWith(204);
	});
});
