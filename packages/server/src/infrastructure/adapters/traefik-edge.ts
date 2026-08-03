import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type {
	AdapterExecutionContext,
	AdapterProbeResult,
	EdgeOperation,
	EdgeOperationResult,
	EdgeProvider,
} from "../contracts";

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const hostnamePattern =
	/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const configVersionPrefix = "# deploytide-edge-version: ";
const configStatusPrefix = "# deploytide-edge-status: ";
const configHostnamePrefix = "# deploytide-edge-hostname: ";
const configDigestPrefix = "# deploytide-edge-content-digest: ";
const withdrawnConfigBody = "http:\n  routers: {}\n  services: {}\n";
const corruptionMessage = "Edge route state is corrupt";
const maxEdgeFileBytes = 64 * 1024;
const NOFOLLOW_FLAG =
	process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);

type EdgeStatus = "published" | "withdrawn";
type EdgeState = {
	hostname: string;
	status: EdgeStatus;
	version: number;
};
type EdgePaths = {
	config: string;
	configTemporary: string;
	lock: string;
	state: string;
	stateTemporary: string;
};

const quoteYaml = (value: string) => JSON.stringify(value);
const nodeErrorCode = (error: unknown) =>
	(error as NodeJS.ErrnoException).code ?? "";

const sameFileMetadata = (
	left: {
		dev: number;
		ino: number;
		isFile(): boolean;
		mtimeMs: number;
		size: number;
	},
	right: {
		dev: number;
		ino: number;
		isFile(): boolean;
		mtimeMs: number;
		size: number;
	},
) =>
	left.isFile() &&
	right.isFile() &&
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.size === right.size &&
	left.mtimeMs === right.mtimeMs;

const throwIfAborted = (signal?: AbortSignal) => {
	if (signal?.aborted) throw signal.reason;
};

const isValidHostname = (hostname: string) =>
	hostname.length <= 253 && hostnamePattern.test(hostname);

const assertExpectedVersion = (version: number) => {
	if (
		!Number.isSafeInteger(version) ||
		version < 0 ||
		version >= Number.MAX_SAFE_INTEGER
	) {
		throw new Error("Edge route version is invalid");
	}
};

const validateEndpoint = (value: string) => {
	if (value.length === 0 || value.length > 2048) {
		throw new Error("Runtime edge endpoint is invalid");
	}
	let endpoint: URL;
	try {
		endpoint = new URL(value);
	} catch {
		throw new Error("Runtime edge endpoint is invalid");
	}
	if (
		!["http:", "https:"].includes(endpoint.protocol) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.hash
	) {
		throw new Error("Runtime edge endpoint is invalid");
	}
	return endpoint;
};

const exactChildPath = (directory: string, name: string) => {
	const candidate = path.resolve(directory, name);
	if (path.dirname(candidate) !== directory) {
		throw new Error("Edge route path containment failed");
	}
	return candidate;
};

const edgePaths = (
	directory: string,
	aliasId: string,
	correlationId: string,
): EdgePaths => {
	const nonce = randomUUID();
	return {
		config: exactChildPath(directory, `${aliasId}.yml`),
		configTemporary: exactChildPath(
			directory,
			`${aliasId}.yml.${correlationId}.${nonce}.tmp`,
		),
		lock: exactChildPath(directory, `${aliasId}.lock`),
		state: exactChildPath(directory, `${aliasId}.state.json`),
		stateTemporary: exactChildPath(
			directory,
			`${aliasId}.state.json.${correlationId}.${nonce}.tmp`,
		),
	};
};

const renderPublishedBody = (
	aliasId: string,
	hostname: string,
	endpoint: URL,
) =>
	[
		"http:",
		"  routers:",
		`    ${aliasId}:`,
		`      rule: ${quoteYaml(`Host(\`${hostname}\`)`)}`,
		`      service: ${aliasId}`,
		"      entryPoints: [websecure]",
		"  services:",
		`    ${aliasId}:`,
		"      loadBalancer:",
		"        servers:",
		`          - url: ${quoteYaml(endpoint.toString())}`,
		"",
	].join("\n");

const renderConfig = (input: EdgeState & { body: string }) => {
	const digest = `sha256:${createHash("sha256")
		.update(input.body, "utf8")
		.digest("hex")}`;
	return [
		`${configVersionPrefix}${input.version}`,
		`${configStatusPrefix}${input.status}`,
		`${configHostnamePrefix}${JSON.stringify(input.hostname)}`,
		`${configDigestPrefix}${digest}`,
		input.body,
	].join("\n");
};

const parseState = (raw: string): EdgeState => {
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(corruptionMessage);
	}
	const record = parsed as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !== "hostname,status,version" ||
		typeof record.version !== "number" ||
		!Number.isSafeInteger(record.version) ||
		record.version <= 0 ||
		(record.status !== "published" && record.status !== "withdrawn") ||
		typeof record.hostname !== "string" ||
		!isValidHostname(record.hostname)
	) {
		throw new Error(corruptionMessage);
	}
	return {
		hostname: record.hostname,
		status: record.status,
		version: record.version,
	};
};

const parseConfig = (raw: string, aliasId: string): EdgeState => {
	const lines = raw.split("\n");
	const versionLine = lines.shift();
	const statusLine = lines.shift();
	const hostnameLine = lines.shift();
	const digestLine = lines.shift();
	if (
		!versionLine?.startsWith(configVersionPrefix) ||
		!statusLine?.startsWith(configStatusPrefix) ||
		!hostnameLine?.startsWith(configHostnamePrefix) ||
		!digestLine?.startsWith(configDigestPrefix)
	) {
		throw new Error(corruptionMessage);
	}
	const versionText = versionLine.slice(configVersionPrefix.length);
	const version = Number(versionText);
	const status = statusLine.slice(configStatusPrefix.length);
	const digest = digestLine.slice(configDigestPrefix.length);
	let hostname: unknown;
	try {
		hostname = JSON.parse(hostnameLine.slice(configHostnamePrefix.length));
	} catch {
		throw new Error(corruptionMessage);
	}
	const body = lines.join("\n");
	const actualDigest = `sha256:${createHash("sha256")
		.update(body, "utf8")
		.digest("hex")}`;
	if (
		!/^\d+$/.test(versionText) ||
		!Number.isSafeInteger(version) ||
		version <= 0 ||
		String(version) !== versionText ||
		(status !== "published" && status !== "withdrawn") ||
		typeof hostname !== "string" ||
		!isValidHostname(hostname) ||
		!digestPattern.test(digest) ||
		digest !== actualDigest
	) {
		throw new Error(corruptionMessage);
	}
	if (status === "withdrawn") {
		if (body !== withdrawnConfigBody) throw new Error(corruptionMessage);
	} else {
		const bodyLines = body.split("\n");
		if (
			bodyLines.length !== 12 ||
			bodyLines[0] !== "http:" ||
			bodyLines[1] !== "  routers:" ||
			bodyLines[2] !== `    ${aliasId}:` ||
			bodyLines[3] !== `      rule: ${quoteYaml(`Host(\`${hostname}\`)`)}` ||
			bodyLines[4] !== `      service: ${aliasId}` ||
			bodyLines[5] !== "      entryPoints: [websecure]" ||
			bodyLines[6] !== "  services:" ||
			bodyLines[7] !== `    ${aliasId}:` ||
			bodyLines[8] !== "      loadBalancer:" ||
			bodyLines[9] !== "        servers:" ||
			!bodyLines[10]?.startsWith("          - url: ") ||
			bodyLines[11] !== ""
		) {
			throw new Error(corruptionMessage);
		}
		let endpoint: unknown;
		try {
			endpoint = JSON.parse(bodyLines[10].slice("          - url: ".length));
		} catch {
			throw new Error(corruptionMessage);
		}
		if (typeof endpoint !== "string") throw new Error(corruptionMessage);
		validateEndpoint(endpoint);
	}
	return { hostname, status, version };
};

const readOptional = async (filePath: string) => {
	let requested: Awaited<ReturnType<typeof lstat>>;
	try {
		requested = await lstat(filePath);
	} catch (error) {
		if (nodeErrorCode(error) === "ENOENT") return null;
		throw error;
	}
	if (
		requested.isSymbolicLink() ||
		!requested.isFile() ||
		requested.size > maxEdgeFileBytes
	) {
		throw new Error(corruptionMessage);
	}
	const handle = await open(filePath, constants.O_RDONLY | NOFOLLOW_FLAG);
	try {
		const before = await handle.stat();
		if (!sameFileMetadata(requested, before)) {
			throw new Error(corruptionMessage);
		}
		const content = await handle.readFile("utf8");
		const [after, pathAfter] = await Promise.all([
			handle.stat(),
			lstat(filePath),
		]);
		if (
			!sameFileMetadata(before, after) ||
			!sameFileMetadata(before, pathAfter)
		) {
			throw new Error(corruptionMessage);
		}
		return content;
	} finally {
		await handle.close();
	}
};

const readCurrentState = async (paths: EdgePaths, aliasId: string) => {
	let configRaw: string | null;
	let stateRaw: string | null;
	try {
		[configRaw, stateRaw] = await Promise.all([
			readOptional(paths.config),
			readOptional(paths.state),
		]);
	} catch {
		throw new Error(corruptionMessage);
	}
	if (configRaw === null && stateRaw === null) return null;
	if (configRaw === null || stateRaw === null) {
		throw new Error(corruptionMessage);
	}
	try {
		const config = parseConfig(configRaw, aliasId);
		const state = parseState(stateRaw);
		if (
			config.version !== state.version ||
			config.status !== state.status ||
			config.hostname !== state.hostname
		) {
			throw new Error(corruptionMessage);
		}
		return state;
	} catch {
		throw new Error(corruptionMessage);
	}
};

const writePrivateAtomic = async (input: {
	content: string;
	signal?: AbortSignal;
	target: string;
	temporary: string;
}) => {
	throwIfAborted(input.signal);
	const handle = await open(
		input.temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
		0o600,
	);
	try {
		await handle.chmod(0o600);
		await handle.writeFile(input.content, {
			encoding: "utf8",
			signal: input.signal,
		});
		await handle.sync();
	} finally {
		await handle.close();
	}
	throwIfAborted(input.signal);
	await rename(input.temporary, input.target);
};

export class TraefikEdgeProvider implements EdgeProvider {
	readonly adapterType = "traefik-file";
	readonly #directory: string;

	constructor(directory: string) {
		this.#directory = path.resolve(directory);
	}

	async probe(context: AdapterExecutionContext): Promise<AdapterProbeResult> {
		throwIfAborted(context.signal);
		await mkdir(this.#directory, { recursive: true });
		return {
			health: "healthy",
			version: "traefik-file-v2",
			capabilities: ["edge.http", "edge.atomic-route", "edge.tls-termination"],
		};
	}

	async execute(
		context: AdapterExecutionContext,
		operation: EdgeOperation,
	): Promise<EdgeOperationResult> {
		if (
			!idPattern.test(operation.aliasId) ||
			!isValidHostname(operation.hostname) ||
			!idPattern.test(context.correlationId)
		) {
			throw new Error("Edge route identity is invalid");
		}
		assertExpectedVersion(operation.expectedVersion);
		const endpoint =
			operation.kind === "route.publish"
				? validateEndpoint(operation.runtimeEndpoint)
				: undefined;
		throwIfAborted(context.signal);
		await mkdir(this.#directory, { recursive: true });
		const paths = edgePaths(
			this.#directory,
			operation.aliasId,
			context.correlationId,
		);
		try {
			await mkdir(paths.lock, { mode: 0o700 });
		} catch (error) {
			if (nodeErrorCode(error) === "EEXIST") {
				throw new Error("Edge route update is already in progress");
			}
			throw error;
		}

		let failure: unknown;
		let result: EdgeOperationResult | undefined;
		try {
			throwIfAborted(context.signal);
			const currentState = await readCurrentState(paths, operation.aliasId);
			const currentVersion = currentState?.version ?? 0;
			if (currentVersion !== operation.expectedVersion) {
				throw new Error(
					"Edge route changed while the operation was in progress",
				);
			}
			if (currentVersion >= Number.MAX_SAFE_INTEGER) {
				throw new Error("Edge route version is invalid");
			}
			const nextVersion = currentVersion + 1;
			const state: EdgeState = {
				hostname: operation.hostname,
				status: operation.kind === "route.publish" ? "published" : "withdrawn",
				version: nextVersion,
			};
			const body =
				operation.kind === "route.publish" && endpoint
					? renderPublishedBody(operation.aliasId, operation.hostname, endpoint)
					: withdrawnConfigBody;
			await writePrivateAtomic({
				content: renderConfig({ ...state, body }),
				signal: context.signal,
				target: paths.config,
				temporary: paths.configTemporary,
			});
			await writePrivateAtomic({
				content: `${JSON.stringify(state)}\n`,
				signal: context.signal,
				target: paths.state,
				temporary: paths.stateTemporary,
			});
			result =
				operation.kind === "route.publish"
					? { kind: "route.published", version: nextVersion }
					: { kind: "route.withdrawn", version: nextVersion };
		} catch (error) {
			failure = error;
		} finally {
			for (const temporary of [paths.configTemporary, paths.stateTemporary]) {
				try {
					await rm(temporary, { force: true });
				} catch (error) {
					failure ??= error;
				}
			}
			try {
				await rmdir(paths.lock);
			} catch (error) {
				failure ??= new Error("Edge route lock could not be released", {
					cause: error,
				});
			}
		}

		if (failure) throw failure;
		if (!result) throw new Error("Edge route update did not produce a result");
		return result;
	}
}
