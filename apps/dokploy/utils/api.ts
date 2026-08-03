import {
	createWSClient,
	httpBatchLink,
	httpLink,
	splitLink,
	wsLink,
} from "@trpc/client";
import { createTRPCNext } from "@trpc/next";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import superjson from "superjson";
import type { AppRouter } from "@/server/api/root";

const getBaseUrl = () => {
	if (typeof window !== "undefined") return "";
	return `http://localhost:${process.env.PORT ?? 3000}`;
};

const getWsUrl = () => {
	if (typeof window === "undefined") return null;

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const host = window.location.host;

	return `${protocol}${host}/drawer-logs`;
};

let wsClientSingleton: ReturnType<typeof createWSClient> | null = null;

const getOrCreateWSClient = () => {
	if (typeof window === "undefined") return null;

	if (!wsClientSingleton) {
		wsClientSingleton = createWSClient({
			url: getWsUrl()!,
			lazy: { enabled: true, closeMs: 3000 },
			retryDelayMs: () => 3000,
		});
	}

	return wsClientSingleton;
};

const wsClient = getOrCreateWSClient();

const links =
	typeof window !== "undefined"
		? [
				splitLink({
					condition: (op) => op.type === "subscription",
					true: wsLink({
						client: wsClient!,
						transformer: superjson,
					}),
					false: splitLink({
						condition: (op) => op.input instanceof FormData,
						true: httpLink({
							url: `${getBaseUrl()}/api/trpc`,
							transformer: superjson,
						}),
						false: httpBatchLink({
							url: `${getBaseUrl()}/api/trpc`,
							transformer: superjson,
						}),
					}),
				}),
			]
		: [
				httpBatchLink({
					url: `${getBaseUrl()}/api/trpc`,
					transformer: superjson,
				}),
			];

export const api = createTRPCNext<AppRouter>({
	config() {
		return { links };
	},
	ssr: false,
	transformer: superjson,
});

let operatorCsrfToken: string | null = null;
let operatorCsrfRequest: Promise<string> | null = null;

const getOperatorCsrfToken = async () => {
	if (typeof window === "undefined") {
		throw new Error("Operator API is browser-only");
	}
	if (operatorCsrfToken) return operatorCsrfToken;
	if (!operatorCsrfRequest) {
		operatorCsrfRequest = fetch("/api/operator/csrf", {
			method: "GET",
			credentials: "same-origin",
			cache: "no-store",
			headers: { Accept: "application/json" },
		})
			.then(async (response) => {
				if (!response.ok) throw new Error("Operator session is unavailable");
				const payload = (await response.json()) as { csrfToken?: unknown };
				if (
					typeof payload.csrfToken !== "string" ||
					!/^[-_A-Za-z0-9]{43}$/.test(payload.csrfToken)
				) {
					throw new Error("Operator session is invalid");
				}
				operatorCsrfToken = payload.csrfToken;
				return payload.csrfToken;
			})
			.finally(() => {
				operatorCsrfRequest = null;
			});
	}
	return operatorCsrfRequest;
};

export const clearOperatorApiSession = () => {
	operatorCsrfToken = null;
	operatorCsrfRequest = null;
};

/** Browser-only operator client. Never import this into customer surfaces. */
export const operatorApi = createTRPCNext<AppRouter>({
	config() {
		return {
			links: [
				httpLink({
					url: "/api/trpc",
					transformer: superjson,
					methodOverride: "POST",
					headers: async () => ({
						"Content-Type": "application/json",
						"X-DeployTide-Operator-CSRF": await getOperatorCsrfToken(),
					}),
				}),
			],
		};
	},
	ssr: false,
	transformer: superjson,
});

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
