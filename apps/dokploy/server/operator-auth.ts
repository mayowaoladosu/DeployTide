import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { TRPCError } from "@trpc/server";

const OPERATOR_AUDIENCE = "deploytide.operator.browser.v1";
const DEVELOPMENT_OPERATOR_COOKIE = "deploytide_operator_session";
const PRODUCTION_OPERATOR_COOKIE = "__Host-deploytide_operator_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const EXCHANGE_WINDOW_MS = 5 * 60 * 1000;
const EXCHANGE_ATTEMPT_LIMIT = 5;
const MAX_EXCHANGE_KEYS = 4_096;
const CLOCK_SKEW_MS = 60_000;

interface OperatorSessionPayload {
	aud: typeof OPERATOR_AUDIENCE;
	sub: string;
	email: string;
	ua: string;
	sid: string;
	csrf: string;
	iat: number;
	exp: number;
}

interface ExchangeWindow {
	count: number;
	resetAt: number;
}

const exchangeWindows = new Map<string, ExchangeWindow>();

const configuredEmails = () =>
	new Set(
		(process.env.DEPLOYTIDE_SUPERADMIN_EMAILS ?? "")
			.split(",")
			.map((email) => email.trim().toLowerCase())
			.filter(Boolean),
	);

const operatorSessionSecret = () => {
	const secret = process.env.DEPLOYTIDE_OPERATOR_SESSION_SECRET;
	if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Operator browser authentication is not configured",
		});
	}
	return secret;
};

const singleHeader = (
	value: string | string[] | undefined,
): string | undefined => (typeof value === "string" ? value : undefined);

const userAgentDigest = (req: IncomingMessage) =>
	createHash("sha256")
		.update(singleHeader(req.headers["user-agent"]) ?? "unknown")
		.digest("base64url");

const signPayload = (encodedPayload: string) =>
	createHmac("sha256", operatorSessionSecret())
		.update(encodedPayload)
		.digest("base64url");

const safeEqual = (left: string, right: string) => {
	const leftDigest = createHash("sha256").update(left).digest();
	const rightDigest = createHash("sha256").update(right).digest();
	return timingSafeEqual(leftDigest, rightDigest);
};

const parseCookies = (header: string | undefined) =>
	new Map(
		(header ?? "")
			.split(";")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const separator = part.indexOf("=");
				if (separator === -1) return [part, ""];
				try {
					return [
						part.slice(0, separator),
						decodeURIComponent(part.slice(separator + 1)),
					];
				} catch {
					return [part.slice(0, separator), ""];
				}
			}),
	);

const isLoopbackHostname = (hostname: string) => {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	if (normalized === "localhost" || normalized.endsWith(".localhost")) {
		return true;
	}
	if (isIP(normalized) === 4) return normalized.startsWith("127.");
	return normalized === "::1" || normalized === "[::1]";
};

const configuredOperatorOrigin = () => {
	const configured = process.env.DEPLOYTIDE_OPERATOR_ORIGIN;
	if (!configured) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Operator browser origin is not configured",
		});
	}
	let origin: URL;
	try {
		origin = new URL(configured);
	} catch {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Operator browser origin is invalid",
		});
	}
	if (
		origin.origin !== configured.replace(/\/$/, "") ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		!(["http:", "https:"] as string[]).includes(origin.protocol) ||
		(process.env.NODE_ENV === "production" && origin.protocol !== "https:") ||
		(origin.protocol === "http:" && !isLoopbackHostname(origin.hostname))
	) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Operator browser origin is invalid",
		});
	}
	return origin.origin;
};

const assertFetchSite = (
	req: IncomingMessage,
	allowed: ReadonlySet<string>,
) => {
	const fetchSite = singleHeader(req.headers["sec-fetch-site"]);
	if (!fetchSite || !allowed.has(fetchSite)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Operator request rejected",
		});
	}
};

const assertJsonContentType = (req: IncomingMessage) => {
	const contentType = singleHeader(req.headers["content-type"]);
	if (
		contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
	) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Operator request rejected",
		});
	}
};

const exactRequestOrigin = (req: IncomingMessage) => {
	const origin = singleHeader(req.headers.origin);
	if (!origin || !safeEqual(origin, configuredOperatorOrigin())) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Operator request rejected",
		});
	}
};

const exactRequestReferer = (req: IncomingMessage) => {
	const referer = singleHeader(req.headers.referer);
	let refererOrigin: string | null = null;
	try {
		refererOrigin = referer ? new URL(referer).origin : null;
	} catch {
		refererOrigin = null;
	}
	if (!refererOrigin || !safeEqual(refererOrigin, configuredOperatorOrigin())) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Operator request rejected",
		});
	}
};

const sessionCookieName = () =>
	process.env.NODE_ENV === "production"
		? PRODUCTION_OPERATOR_COOKIE
		: DEVELOPMENT_OPERATOR_COOKIE;

const cookieAttributes = (maxAge: number) => {
	const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
	return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
};

const remoteAddress = (req: IncomingMessage) =>
	req.socket?.remoteAddress?.trim().toLowerCase() || "unknown";

const exchangeKey = (req: IncomingMessage, userId: string) =>
	createHash("sha256")
		.update(`${userId}\0${remoteAddress(req)}`)
		.digest("base64url");

const pruneExchangeWindows = (now: number) => {
	for (const [key, value] of exchangeWindows) {
		if (value.resetAt <= now) exchangeWindows.delete(key);
	}
	while (exchangeWindows.size >= MAX_EXCHANGE_KEYS) {
		const oldest = exchangeWindows.keys().next().value;
		if (typeof oldest !== "string") break;
		exchangeWindows.delete(oldest);
	}
};

export const isConfiguredSuperadmin = (email: string) =>
	configuredEmails().has(email.trim().toLowerCase());

export const assertOperatorAccessToken = (provided: string | undefined) => {
	const expected = process.env.DEPLOYTIDE_OPERATOR_API_TOKEN;
	if (!expected || !provided || !safeEqual(expected, provided)) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
};

export const consumeOperatorSessionExchangeAttempt = (input: {
	req: IncomingMessage;
	userId: string;
	now?: Date;
}) => {
	const now = (input.now ?? new Date()).getTime();
	pruneExchangeWindows(now);
	const key = exchangeKey(input.req, input.userId);
	const current = exchangeWindows.get(key);
	if (
		current &&
		current.resetAt > now &&
		current.count >= EXCHANGE_ATTEMPT_LIMIT
	) {
		throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
	}
	const next =
		current && current.resetAt > now
			? { count: current.count + 1, resetAt: current.resetAt }
			: { count: 1, resetAt: now + EXCHANGE_WINDOW_MS };
	exchangeWindows.delete(key);
	exchangeWindows.set(key, next);
};

export const resetOperatorSessionExchangeAttempts = (input: {
	req: IncomingMessage;
	userId: string;
}) => {
	exchangeWindows.delete(exchangeKey(input.req, input.userId));
};

export const createOperatorSessionToken = (input: {
	userId: string;
	email: string;
	req: IncomingMessage;
	now?: Date;
}) => {
	if (!isConfiguredSuperadmin(input.email)) {
		throw new TRPCError({ code: "FORBIDDEN" });
	}
	const now = input.now ?? new Date();
	const payload: OperatorSessionPayload = {
		aud: OPERATOR_AUDIENCE,
		sub: input.userId,
		email: input.email.trim().toLowerCase(),
		ua: userAgentDigest(input.req),
		sid: randomBytes(24).toString("base64url"),
		csrf: randomBytes(32).toString("base64url"),
		iat: now.getTime(),
		exp: now.getTime() + SESSION_TTL_MS,
	};
	const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
		"base64url",
	);
	return `${encoded}.${signPayload(encoded)}`;
};

export const setOperatorSessionCookie = (
	res: ServerResponse,
	token: string,
) => {
	const cookies = [
		`${sessionCookieName()}=${encodeURIComponent(token)}; ${cookieAttributes(
			Math.floor(SESSION_TTL_MS / 1000),
		)}`,
	];
	if (process.env.NODE_ENV === "production") {
		cookies.push(
			`${DEVELOPMENT_OPERATOR_COOKIE}=; ${cookieAttributes(0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
		);
	}
	res.setHeader("Set-Cookie", cookies);
};

export const clearOperatorSessionCookie = (res: ServerResponse) => {
	const names = new Set([sessionCookieName(), DEVELOPMENT_OPERATOR_COOKIE]);
	res.setHeader(
		"Set-Cookie",
		[...names].map(
			(name) =>
				`${name}=; ${cookieAttributes(0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
		),
	);
};

export const readOperatorSession = (input: {
	req: IncomingMessage;
	userId: string;
	email: string;
	now?: Date;
}): OperatorSessionPayload | null => {
	if (!isConfiguredSuperadmin(input.email)) return null;
	const token = parseCookies(singleHeader(input.req.headers.cookie)).get(
		sessionCookieName(),
	);
	if (!token || token.length > 8_192) return null;
	const separator = token.lastIndexOf(".");
	if (separator <= 0) return null;
	const encoded = token.slice(0, separator);
	const signature = token.slice(separator + 1);
	let expected: string;
	try {
		expected = signPayload(encoded);
	} catch {
		return null;
	}
	if (!safeEqual(signature, expected)) return null;
	try {
		const payload = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		) as Partial<OperatorSessionPayload>;
		const now = (input.now ?? new Date()).getTime();
		if (
			payload.aud !== OPERATOR_AUDIENCE ||
			payload.sub !== input.userId ||
			payload.email !== input.email.trim().toLowerCase() ||
			payload.ua !== userAgentDigest(input.req) ||
			typeof payload.sid !== "string" ||
			!/^[-_A-Za-z0-9]{32}$/.test(payload.sid) ||
			typeof payload.csrf !== "string" ||
			!/^[-_A-Za-z0-9]{43}$/.test(payload.csrf) ||
			typeof payload.iat !== "number" ||
			typeof payload.exp !== "number" ||
			payload.iat > now + CLOCK_SKEW_MS ||
			payload.exp <= now ||
			payload.exp - payload.iat !== SESSION_TTL_MS
		) {
			return null;
		}
		return payload as OperatorSessionPayload;
	} catch {
		return null;
	}
};

export const verifyOperatorSession = (input: {
	req: IncomingMessage;
	userId: string;
	email: string;
	now?: Date;
}) => Boolean(readOperatorSession(input));

export const assertOperatorBrowserRequest = (input: {
	req: IncomingMessage;
	userId: string;
	email: string;
	type: "query" | "mutation" | "subscription";
}) => {
	const session = readOperatorSession(input);
	if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
	exactRequestOrigin(input.req);
	assertFetchSite(
		input.req,
		input.type === "query"
			? new Set(["same-origin", "none"])
			: new Set(["same-origin"]),
	);
	if (input.type !== "query") {
		assertJsonContentType(input.req);
		const contentLength = Number(
			singleHeader(input.req.headers["content-length"]),
		);
		if (Number.isFinite(contentLength) && contentLength > 256 * 1024) {
			throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
		}
		const csrf = singleHeader(input.req.headers["x-deploytide-operator-csrf"]);
		if (!csrf || !safeEqual(csrf, session.csrf)) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "Operator request rejected",
			});
		}
	}
	return session;
};

export const assertOperatorSessionExchangeRequest = (req: IncomingMessage) => {
	exactRequestOrigin(req);
	assertFetchSite(req, new Set(["same-origin"]));
	assertJsonContentType(req);
};

export const assertOperatorCsrfBootstrapRequest = (req: IncomingMessage) => {
	assertFetchSite(req, new Set(["same-origin"]));
	const origin = singleHeader(req.headers.origin);
	if (origin) exactRequestOrigin(req);
	else exactRequestReferer(req);
};

export const assertOperatorLogoutRequest = (input: {
	req: IncomingMessage;
	userId: string;
	email: string;
}) =>
	assertOperatorBrowserRequest({
		...input,
		type: "mutation",
	});

export const assertSuperadminSession = (input: {
	req: IncomingMessage;
	userId: string;
	email: string;
}) => {
	if (!readOperatorSession(input)) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
};

export const operatorSessionCookieName = sessionCookieName();
