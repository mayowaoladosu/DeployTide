import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { z } from "zod";
import type {
	AdapterExecutionContext,
	AdapterProbeResult,
	InfrastructureOperation,
	InfrastructureOperationResult,
	InfrastructureProvider,
} from "../contracts";
import { resolveOperatorSecretReference } from "../secret-reference";

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

const provisionedResponse = z.object({
	providerTargetReference: z.string().min(1),
	architecture: z.enum(["amd64", "arm64"]),
	version: z.string().min(1),
});

const inspectedResponse = z.object({
	health: z.enum(["healthy", "degraded", "unavailable"]),
	cpuMillis: z.number().int().nonnegative(),
	memoryMb: z.number().int().nonnegative(),
});

const probeResponse = z.object({
	health: z.enum(["healthy", "degraded", "unavailable"]),
	version: z.string().min(1),
	capabilities: z.array(z.string()),
});

export interface LayerRailResolvedAddress {
	address: string;
	family: 4 | 6;
}

export type LayerRailResolver = (
	hostname: string,
) => Promise<LayerRailResolvedAddress[]>;

const defaultResolver: LayerRailResolver = async (hostname) =>
	lookup(hostname, { all: true, verbatim: true }) as Promise<
		LayerRailResolvedAddress[]
	>;

const normalizedHostname = (hostname: string) =>
	hostname.toLowerCase().replace(/\.$/, "");

const isLoopbackHostname = (hostname: string) => {
	const normalized = normalizedHostname(hostname);
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.startsWith("127.") ||
		normalized === "::1"
	);
};

const isPublicIpv4 = (address: string) => {
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
		return false;
	}
	const [a, b, c] = octets as [number, number, number, number];
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 0 && c === 2) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
};

const isPublicIpv6 = (address: string) => {
	let normalized: string;
	try {
		normalized = new URL(`http://[${address}]/`).hostname
			.replace(/^\[/, "")
			.replace(/\]$/, "")
			.toLowerCase();
	} catch {
		return false;
	}
	const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
	if (mapped) return isPublicIpv4(mapped);
	const first = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16);
	return !(
		!Number.isInteger(first) ||
		first < 0x2000 ||
		first > 0x3fff ||
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("::ffff:") ||
		normalized.startsWith("64:ff9b:1:") ||
		normalized.startsWith("100:") ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		/^fe[89ab]/.test(normalized) ||
		normalized.startsWith("ff") ||
		normalized.startsWith("2001:0:") ||
		normalized.startsWith("2001:db8:") ||
		normalized.startsWith("2001:2:") ||
		normalized.startsWith("2001:10:") ||
		normalized.startsWith("2001:20:") ||
		normalized.startsWith("2002:") ||
		normalized.startsWith("3fff:") ||
		normalized.startsWith("5f00:")
	);
};

const assertPublicAddress = (address: string) => {
	const family = isIP(address);
	if (
		family === 0 ||
		(family === 4 && !isPublicIpv4(address)) ||
		(family === 6 && !isPublicIpv6(address))
	) {
		throw new Error("LayerRail endpoint resolved to a forbidden address");
	}
};

const configuredAllowedHosts = () =>
	(process.env.DEPLOYTIDE_LAYERRAIL_ALLOWED_HOSTS ?? "")
		.split(",")
		.map((value) => normalizedHostname(value.trim()))
		.filter(Boolean);

const assertAllowedHostname = (hostname: string) => {
	if (process.env.NODE_ENV !== "production") return;
	const normalized = normalizedHostname(hostname);
	const allowed = configuredAllowedHosts();
	if (
		allowed.length === 0 ||
		!allowed.some((entry) =>
			entry.startsWith(".")
				? normalized.endsWith(entry) && normalized.length > entry.length
				: normalized === entry,
		)
	) {
		throw new Error("LayerRail endpoint hostname is not allowlisted");
	}
};

const validateEndpoint = (value: string) => {
	const endpoint = new URL(value);
	if (endpoint.username || endpoint.password) {
		throw new Error("LayerRail endpoint cannot contain credentials");
	}
	const loopback = isLoopbackHostname(endpoint.hostname);
	if (
		endpoint.protocol !== "https:" &&
		!(
			process.env.NODE_ENV !== "production" &&
			endpoint.protocol === "http:" &&
			loopback
		)
	) {
		throw new Error("LayerRail Compute endpoint must use HTTPS");
	}
	assertAllowedHostname(endpoint.hostname);
	endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/`;
	endpoint.search = "";
	endpoint.hash = "";
	return endpoint;
};

const addressSet = (addresses: LayerRailResolvedAddress[]) =>
	new Set(addresses.map(({ address }) => address.toLowerCase()));

const sameAddressSet = (left: Set<string>, right: Set<string>) =>
	left.size === right.size && [...left].every((value) => right.has(value));

const pinnedFetch = async (
	url: URL,
	init: RequestInit,
	pinnedAddress: string,
): Promise<Response> =>
	new Promise((resolve, reject) => {
		const client = url.protocol === "https:" ? https : http;
		const headers = new Headers(init.headers);
		headers.set(
			"Host",
			url.port ? `${url.hostname}:${url.port}` : url.hostname,
		);
		const request = client.request(
			{
				protocol: url.protocol,
				hostname: pinnedAddress,
				port: url.port || undefined,
				path: `${url.pathname}${url.search}`,
				method: init.method ?? "GET",
				headers: Object.fromEntries(headers.entries()),
				servername: url.hostname,
				rejectUnauthorized: true,
				signal: init.signal ?? undefined,
			},
			(incoming) => {
				const responseHeaders = new Headers();
				for (const [key, value] of Object.entries(incoming.headers)) {
					if (Array.isArray(value)) {
						for (const item of value) responseHeaders.append(key, item);
					} else if (value !== undefined) {
						responseHeaders.set(key, value);
					}
				}
				resolve(
					new Response(Readable.toWeb(incoming) as ReadableStream, {
						status: incoming.statusCode ?? 500,
						statusText: incoming.statusMessage,
						headers: responseHeaders,
					}),
				);
			},
		);
		request.once("error", reject);
		if (typeof init.body === "string" || init.body instanceof Uint8Array) {
			request.end(init.body);
		} else if (init.body == null) {
			request.end();
		} else {
			request.destroy(new Error("LayerRail Compute request body is invalid"));
		}
	});

const responseBody = async (response: Response) => {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		throw new Error("LayerRail Compute response is too large");
	}
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error("LayerRail Compute response is too large");
		}
		chunks.push(value);
	}
	if (length === 0) return null;
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
};

export class LayerRailComputeInfrastructureProvider
	implements InfrastructureProvider
{
	readonly adapterType = "layerrail-compute";
	readonly #endpoint: URL;
	readonly #secretId: string;
	readonly #fetch: typeof fetch | null;
	readonly #resolver: LayerRailResolver;

	constructor(input: {
		endpoint: string;
		secretId: string;
		fetch?: typeof fetch;
		resolver?: LayerRailResolver;
	}) {
		this.#endpoint = validateEndpoint(input.endpoint);
		this.#secretId = input.secretId;
		this.#fetch = input.fetch ?? null;
		this.#resolver = input.resolver ?? defaultResolver;
	}

	async #resolveEndpoint() {
		const addresses = await this.#resolver(this.#endpoint.hostname);
		if (addresses.length === 0 || addresses.length > 16) {
			throw new Error("LayerRail endpoint did not resolve safely");
		}
		if (process.env.NODE_ENV === "production") {
			for (const { address } of addresses) assertPublicAddress(address);
		}
		return addressSet(addresses);
	}

	async #request(
		requestPath: string,
		init: RequestInit,
		context: AdapterExecutionContext,
	): Promise<unknown> {
		const token = await resolveOperatorSecretReference(this.#secretId);
		if (!token) throw new Error("LayerRail Compute credential is unavailable");
		const initialAddresses = await this.#resolveEndpoint();
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const signal = context.signal
			? AbortSignal.any([context.signal, timeout])
			: timeout;
		const requestUrl = new URL(requestPath, this.#endpoint);
		const requestInit: RequestInit = {
			...init,
			signal,
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"Idempotency-Key": context.correlationId,
				"X-DeployTide-Fencing-Token": String(context.fencingToken),
				...init.headers,
			},
			redirect: "error",
		};
		const pinnedAddress = [...initialAddresses].sort()[0];
		if (!pinnedAddress) {
			throw new Error("LayerRail endpoint did not resolve safely");
		}
		const response = this.#fetch
			? await this.#fetch(requestUrl, requestInit)
			: await pinnedFetch(requestUrl, requestInit, pinnedAddress);
		if (response.url) {
			const final = new URL(response.url);
			if (
				final.origin !== this.#endpoint.origin ||
				normalizedHostname(final.hostname) !==
					normalizedHostname(this.#endpoint.hostname)
			) {
				throw new Error("LayerRail Compute response changed origin");
			}
		}
		const finalAddresses = await this.#resolveEndpoint();
		if (!sameAddressSet(initialAddresses, finalAddresses)) {
			throw new Error("LayerRail endpoint DNS changed during request");
		}
		if (!response.ok) {
			throw new Error(
				`LayerRail Compute request failed with status ${response.status}`,
			);
		}
		return response.status === 204 ? null : responseBody(response);
	}

	async probe(context: AdapterExecutionContext): Promise<AdapterProbeResult> {
		return probeResponse.parse(
			await this.#request(
				"v1/operator/capacity/health",
				{ method: "GET" },
				context,
			),
		);
	}

	async execute(
		context: AdapterExecutionContext,
		operation: InfrastructureOperation,
	): Promise<InfrastructureOperationResult> {
		if (operation.kind === "capacity.provision") {
			const response = provisionedResponse.parse(
				await this.#request(
					"v1/operator/capacity",
					{
						method: "POST",
						body: JSON.stringify({
							...operation,
							providerId: context.providerId,
							regionCode: context.regionCode,
						}),
					},
					context,
				),
			);
			return { kind: "capacity.provisioned", ...response };
		}
		if (operation.kind === "capacity.deprovision") {
			await this.#request(
				`v1/operator/capacity/${encodeURIComponent(operation.providerTargetReference)}`,
				{ method: "DELETE" },
				context,
			);
			return { kind: "capacity.deprovisioned" };
		}
		const response = inspectedResponse.parse(
			await this.#request(
				`v1/operator/capacity/${encodeURIComponent(operation.providerTargetReference)}`,
				{ method: "GET" },
				context,
			),
		);
		return { kind: "capacity.inspected", ...response };
	}
}
