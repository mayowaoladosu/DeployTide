import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertOperatorAccessToken,
	assertOperatorBrowserRequest,
	consumeOperatorSessionExchangeAttempt,
	createOperatorSessionToken,
	operatorSessionCookieName,
	setOperatorSessionCookie,
	verifyOperatorSession,
} from "@/server/operator-auth";

const email = "operator@deploytide.test";
const userId = "operator-user";
const request = (
	cookie?: string,
	userAgent = "phase4-browser",
	headers: Record<string, string | undefined> = {},
) =>
	({
		headers: { cookie, "user-agent": userAgent, ...headers },
		socket: { remoteAddress: "127.0.0.1" },
	}) as never;

afterEach(() => vi.unstubAllEnvs());

describe("operator browser audience", () => {
	it("requires both the operator token and configured superadmin email", () => {
		vi.stubEnv("DEPLOYTIDE_OPERATOR_API_TOKEN", "operator-token");
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SESSION_SECRET",
			"operator-browser-session-secret-longer-than-32-bytes",
		);
		vi.stubEnv("DEPLOYTIDE_SUPERADMIN_EMAILS", email);
		expect(() => assertOperatorAccessToken("operator-token")).not.toThrow();
		expect(() => assertOperatorAccessToken("wrong-token")).toThrow();
		expect(() =>
			createOperatorSessionToken({
				userId,
				email: "customer@deploytide.test",
				req: request(),
			}),
		).toThrow();
	});

	it("binds the signed session to user, email, browser and expiry", () => {
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SESSION_SECRET",
			"operator-browser-session-secret-longer-than-32-bytes",
		);
		vi.stubEnv("DEPLOYTIDE_SUPERADMIN_EMAILS", email);
		const now = new Date("2026-08-03T00:00:00.000Z");
		const token = createOperatorSessionToken({
			userId,
			email,
			req: request(),
			now,
		});
		const cookie = `${operatorSessionCookieName}=${encodeURIComponent(token)}`;
		expect(
			verifyOperatorSession({
				req: request(cookie),
				userId,
				email,
				now: new Date(now.getTime() + 1_000),
			}),
		).toBe(true);
		expect(
			verifyOperatorSession({
				req: request(cookie, "different-browser"),
				userId,
				email,
				now: new Date(now.getTime() + 1_000),
			}),
		).toBe(false);
		expect(
			verifyOperatorSession({
				req: request(cookie),
				userId: "another-user",
				email,
				now: new Date(now.getTime() + 1_000),
			}),
		).toBe(false);
		expect(
			verifyOperatorSession({
				req: request(cookie),
				userId,
				email,
				now: new Date(now.getTime() + 9 * 60 * 60 * 1_000),
			}),
		).toBe(false);
	});

	it("requires exact configured origin, same-origin fetch metadata, JSON, and CSRF", () => {
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SESSION_SECRET",
			"operator-browser-session-secret-longer-than-32-bytes",
		);
		vi.stubEnv("DEPLOYTIDE_SUPERADMIN_EMAILS", email);
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_ORIGIN",
			"https://operator.deploytide.test",
		);
		const token = createOperatorSessionToken({ userId, email, req: request() });
		const payload = JSON.parse(
			Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
		) as { csrf: string };
		const cookie = `${operatorSessionCookieName}=${encodeURIComponent(token)}`;
		const valid = request(cookie, "phase4-browser", {
			origin: "https://operator.deploytide.test",
			"sec-fetch-site": "same-origin",
			"content-type": "application/json",
			"x-deploytide-operator-csrf": payload.csrf,
		});
		const validHeaders = {
			origin: "https://operator.deploytide.test",
			"sec-fetch-site": "same-origin",
			"content-type": "application/json",
			"x-deploytide-operator-csrf": payload.csrf,
		};
		expect(() =>
			assertOperatorBrowserRequest({
				req: valid,
				userId,
				email,
				type: "mutation",
			}),
		).not.toThrow();
		for (const headers of [
			{ ...validHeaders, origin: "https://deploytide.test" },
			{ ...validHeaders, origin: "https://sibling.deploytide.test" },
			{ ...validHeaders, "sec-fetch-site": "same-site" },
			{ ...validHeaders, "x-deploytide-operator-csrf": undefined },
			{ ...validHeaders, "x-deploytide-operator-csrf": "x".repeat(43) },
		]) {
			expect(() =>
				assertOperatorBrowserRequest({
					req: request(cookie, "phase4-browser", headers),
					userId,
					email,
					type: "mutation",
				}),
			).toThrow();
		}
	});

	it("rejects a tampered nonce even when the payload remains parseable", () => {
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SESSION_SECRET",
			"operator-browser-session-secret-longer-than-32-bytes",
		);
		vi.stubEnv("DEPLOYTIDE_SUPERADMIN_EMAILS", email);
		const token = createOperatorSessionToken({ userId, email, req: request() });
		const [encoded, signature] = token.split(".");
		const payload = JSON.parse(
			Buffer.from(encoded ?? "", "base64url").toString("utf8"),
		) as Record<string, unknown>;
		payload.csrf = "x".repeat(43);
		const tampered = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
		expect(
			verifyOperatorSession({
				req: request(`${operatorSessionCookieName}=${tampered}`),
				userId,
				email,
			}),
		).toBe(false);
	});

	it("uses a Secure __Host cookie in production without Domain", () => {
		vi.stubEnv("NODE_ENV", "production");
		const setHeader = vi.fn();
		setOperatorSessionCookie({ setHeader } as never, "signed-token");
		const cookies = setHeader.mock.calls[0]?.[1] as string[];
		expect(cookies[0]).toContain("__Host-deploytide_operator_session=");
		expect(cookies[0]).toContain("Path=/");
		expect(cookies[0]).toContain("Secure");
		expect(cookies[0]).toContain("HttpOnly");
		expect(cookies[0]).toContain("SameSite=Strict");
		expect(cookies[0]).not.toContain("Domain=");
	});

	it("does not encode the operator API token in the session cookie", () => {
		vi.stubEnv(
			"DEPLOYTIDE_OPERATOR_SESSION_SECRET",
			"operator-browser-session-secret-longer-than-32-bytes",
		);
		vi.stubEnv("DEPLOYTIDE_SUPERADMIN_EMAILS", email);
		vi.stubEnv("DEPLOYTIDE_OPERATOR_API_TOKEN", "operator-token");
		const token = createOperatorSessionToken({ userId, email, req: request() });
		expect(token).not.toContain("operator-token");
		expect(token).not.toContain(
			createHash("sha256").update("operator-token").digest("hex"),
		);
	});

	it("does not accept a customer token as the operator access token", () => {
		vi.stubEnv("DEPLOYTIDE_OPERATOR_API_TOKEN", "operator-token");
		expect(() => assertOperatorAccessToken("customer-api-token")).toThrow();
	});

	it("rate limits repeated session exchanges by user and source address", () => {
		const now = new Date("2026-08-03T10:00:00.000Z");
		for (let attempt = 0; attempt < 5; attempt += 1) {
			expect(() =>
				consumeOperatorSessionExchangeAttempt({
					req: request(undefined, "limiter-browser"),
					userId: "rate-limited-user",
					now,
				}),
			).not.toThrow();
		}
		expect(() =>
			consumeOperatorSessionExchangeAttempt({
				req: request(undefined, "limiter-browser"),
				userId: "rate-limited-user",
				now,
			}),
		).toThrow();
		expect(() =>
			consumeOperatorSessionExchangeAttempt({
				req: request(undefined, "limiter-browser"),
				userId: "different-user",
				now,
			}),
		).not.toThrow();
	});
});
