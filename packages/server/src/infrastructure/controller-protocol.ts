import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign,
	verify,
} from "node:crypto";

export const CONTROLLER_PROTOCOL_VERSION = "deploytide.runtime-controller.v1";

export type ControllerJobKind =
	| "release_create"
	| "release_health"
	| "release_drain"
	| "release_logs"
	| "cluster_health"
	| "certificate_rotate";

export interface ControllerJobPayloadByKind {
	release_create: {
		releaseId: string;
		imageReference: string;
		imageDigest: string;
		environment: Record<string, string>;
		containerPort: number;
		cpuMillis: number;
		memoryMb: number;
	};
	release_health: { releaseId: string };
	release_drain: { releaseId: string; graceSeconds: number };
	release_logs: { releaseId: string; tail: number };
	cluster_health: Record<string, never>;
	certificate_rotate: Record<string, never>;
}

export interface ControllerJobEnvelope {
	version: typeof CONTROLLER_PROTOCOL_VERSION;
	attemptId: string;
	clusterId: string;
	sequence: number;
	fencingToken: number;
	resourceKey: string;
	kind: ControllerJobKind;
	issuedAt: string;
	expiresAt: string;
	payload: string;
	signature: string;
}

export type UnsignedControllerJobEnvelope = Omit<
	ControllerJobEnvelope,
	"signature"
>;

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_ENCODED_PAYLOAD_LENGTH = Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3);
const identifierPattern = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,191}$/;
const environmentKeyPattern = /^[A-Z_][A-Z0-9_]{0,127}$/;
const imagePattern = /^[a-z0-9][a-z0-9._/@:-]{0,511}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const kinds = new Set<ControllerJobKind>([
	"release_create",
	"release_health",
	"release_drain",
	"release_logs",
	"cluster_health",
	"certificate_rotate",
]);
const releaseKinds = new Set<ControllerJobKind>([
	"release_create",
	"release_health",
	"release_drain",
	"release_logs",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

function assertExactKeys(
	value: unknown,
	expected: readonly string[],
	label: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const expectedSet = new Set(expected);
	const keys = Object.keys(value);
	for (const key of keys) {
		if (!expectedSet.has(key))
			throw new Error(`${label} contains unknown field ${key}`);
	}
	for (const key of expected) {
		if (!Object.hasOwn(value, key))
			throw new Error(`${label} is missing field ${key}`);
	}
}

function assertIdentifier(
	value: unknown,
	label: string,
): asserts value is string {
	if (typeof value !== "string" || !identifierPattern.test(value)) {
		throw new Error(`${label} is invalid`);
	}
}

function assertBoundedString(
	value: unknown,
	label: string,
	maxLength: number,
): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength
	) {
		throw new Error(`${label} is invalid`);
	}
}

function assertInteger(
	value: unknown,
	label: string,
	minimum: number,
	maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < minimum ||
		(value as number) > maximum
	) {
		throw new Error(`${label} is invalid`);
	}
}

function assertControllerJobPayload<K extends ControllerJobKind>(
	kind: K,
	payload: unknown,
): asserts payload is ControllerJobPayloadByKind[K] {
	if (kind === "release_create") {
		assertExactKeys(
			payload,
			[
				"releaseId",
				"imageReference",
				"imageDigest",
				"environment",
				"containerPort",
				"cpuMillis",
				"memoryMb",
			],
			"release_create payload",
		);
		assertIdentifier(payload.releaseId, "releaseId");
		if (
			typeof payload.imageReference !== "string" ||
			!imagePattern.test(payload.imageReference)
		) {
			throw new Error("imageReference is invalid");
		}
		if (
			typeof payload.imageDigest !== "string" ||
			!digestPattern.test(payload.imageDigest)
		) {
			throw new Error("imageDigest is invalid");
		}
		if (!isRecord(payload.environment)) {
			throw new Error("environment must be an object");
		}
		for (const [key, value] of Object.entries(payload.environment)) {
			if (
				!environmentKeyPattern.test(key) ||
				typeof value !== "string" ||
				Buffer.byteLength(value, "utf8") > 32_768
			) {
				throw new Error("environment entry is invalid");
			}
		}
		assertInteger(payload.containerPort, "containerPort", 1, 65_535);
		assertInteger(payload.cpuMillis, "cpuMillis", 1);
		assertInteger(payload.memoryMb, "memoryMb", 1);
		return;
	}
	if (kind === "release_health") {
		assertExactKeys(payload, ["releaseId"], "release_health payload");
		assertIdentifier(payload.releaseId, "releaseId");
		return;
	}
	if (kind === "release_drain") {
		assertExactKeys(
			payload,
			["releaseId", "graceSeconds"],
			"release_drain payload",
		);
		assertIdentifier(payload.releaseId, "releaseId");
		assertInteger(payload.graceSeconds, "graceSeconds", 0, 300);
		return;
	}
	if (kind === "release_logs") {
		assertExactKeys(payload, ["releaseId", "tail"], "release_logs payload");
		assertIdentifier(payload.releaseId, "releaseId");
		assertInteger(payload.tail, "tail", 1, 5_000);
		return;
	}
	assertExactKeys(payload, [], `${kind} payload`);
}

const canonicalJson = (value: unknown): string => {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("Controller payload number is invalid");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	throw new Error("Controller payload contains a non-JSON value");
};

const decodeBase64Url = (
	value: string,
	label: string,
	maximumLength: number,
) => {
	if (
		value.length === 0 ||
		value.length > maximumLength ||
		!base64UrlPattern.test(value) ||
		value.length % 4 === 1
	) {
		throw new Error(`${label} is not canonical base64url`);
	}
	const decoded = Buffer.from(value, "base64url");
	if (decoded.toString("base64url") !== value) {
		throw new Error(`${label} is not canonical base64url`);
	}
	return decoded;
};

export const encodeControllerJobPayload = <K extends ControllerJobKind>(
	kind: K,
	payload: unknown,
): string => {
	assertControllerJobPayload(kind, payload);
	const encoded = Buffer.from(canonicalJson(payload), "utf8");
	if (encoded.length === 0 || encoded.length > MAX_PAYLOAD_BYTES) {
		throw new Error("Controller payload is too large");
	}
	return encoded.toString("base64url");
};

export const decodeControllerJobPayload = <K extends ControllerJobKind>(
	kind: K,
	payload: string,
): ControllerJobPayloadByKind[K] => {
	const decoded = decodeBase64Url(
		payload,
		"Controller payload",
		MAX_ENCODED_PAYLOAD_LENGTH,
	);
	if (decoded.length > MAX_PAYLOAD_BYTES) {
		throw new Error("Controller payload is too large");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(decoded),
		);
	} catch {
		throw new Error("Controller payload is not strict UTF-8 JSON");
	}
	assertControllerJobPayload(kind, parsed);
	return parsed;
};

export const controllerJobResourceKey = <K extends ControllerJobKind>(
	kind: K,
	payload: unknown,
	clusterId: string,
): string => {
	assertIdentifier(clusterId, "clusterId");
	assertControllerJobPayload(kind, payload);
	if (releaseKinds.has(kind)) {
		return `release:${(payload as ControllerJobPayloadByKind["release_health"]).releaseId}`;
	}
	return `cluster:${clusterId}`;
};

const unsignedKeys = [
	"version",
	"attemptId",
	"clusterId",
	"sequence",
	"fencingToken",
	"resourceKey",
	"kind",
	"issuedAt",
	"expiresAt",
	"payload",
] as const;

function validateUnsignedEnvelope(
	envelope: unknown,
): asserts envelope is UnsignedControllerJobEnvelope {
	assertExactKeys(envelope, unsignedKeys, "Controller envelope");
	if (envelope.version !== CONTROLLER_PROTOCOL_VERSION) {
		throw new Error("Controller protocol version is unsupported");
	}
	assertIdentifier(envelope.attemptId, "attemptId");
	assertIdentifier(envelope.clusterId, "clusterId");
	assertInteger(envelope.sequence, "sequence", 1);
	assertInteger(envelope.fencingToken, "fencingToken", 1);
	if (
		typeof envelope.kind !== "string" ||
		!kinds.has(envelope.kind as ControllerJobKind)
	) {
		throw new Error("Controller job kind is invalid");
	}
	assertBoundedString(envelope.resourceKey, "resourceKey", 256);
	assertBoundedString(envelope.issuedAt, "issuedAt", 64);
	assertBoundedString(envelope.expiresAt, "expiresAt", 64);
	assertBoundedString(envelope.payload, "payload", MAX_ENCODED_PAYLOAD_LENGTH);
	const issuedAt = new Date(envelope.issuedAt).getTime();
	const expiresAt = new Date(envelope.expiresAt).getTime();
	if (
		!timestampPattern.test(envelope.issuedAt) ||
		!timestampPattern.test(envelope.expiresAt) ||
		!Number.isFinite(issuedAt) ||
		!Number.isFinite(expiresAt) ||
		new Date(issuedAt).toISOString() !== envelope.issuedAt ||
		new Date(expiresAt).toISOString() !== envelope.expiresAt ||
		expiresAt <= issuedAt ||
		expiresAt - issuedAt > 2 * 60_000
	) {
		throw new Error("Controller job validity window is invalid");
	}
	const payload = decodeControllerJobPayload(
		envelope.kind as ControllerJobKind,
		envelope.payload,
	);
	if (
		envelope.resourceKey !==
		controllerJobResourceKey(
			envelope.kind as ControllerJobKind,
			payload,
			envelope.clusterId,
		)
	) {
		throw new Error("Controller resource key does not match its payload");
	}
}

export const controllerJobSigningInput = (
	envelope: UnsignedControllerJobEnvelope,
) => {
	validateUnsignedEnvelope(envelope);
	const payload = decodeBase64Url(
		envelope.payload,
		"Controller payload",
		MAX_ENCODED_PAYLOAD_LENGTH,
	);
	const payloadDigest = createHash("sha256").update(payload).digest("hex");
	return Buffer.from(
		[
			envelope.version,
			envelope.attemptId,
			envelope.clusterId,
			String(envelope.sequence),
			String(envelope.fencingToken),
			envelope.resourceKey,
			envelope.kind,
			envelope.issuedAt,
			envelope.expiresAt,
			payloadDigest,
		].join("\n"),
		"utf8",
	);
};

export const signControllerJob = (
	envelope: UnsignedControllerJobEnvelope,
	privateKeyPem: string,
): ControllerJobEnvelope => ({
	...envelope,
	signature: sign(
		null,
		controllerJobSigningInput(envelope),
		createPrivateKey(privateKeyPem),
	).toString("base64url"),
});

export const verifyControllerJob = (
	envelope: ControllerJobEnvelope,
	publicKeyPem: string,
	input?: { expectedClusterId?: string; now?: Date },
) => {
	try {
		assertExactKeys(
			envelope,
			[...unsignedKeys, "signature"],
			"Signed controller envelope",
		);
		const { signature, ...unsigned } = envelope;
		validateUnsignedEnvelope(unsigned);
		if (
			input?.expectedClusterId &&
			envelope.clusterId !== input.expectedClusterId
		) {
			return false;
		}
		const now = (input?.now ?? new Date()).getTime();
		if (
			new Date(envelope.issuedAt).getTime() > now + 60_000 ||
			new Date(envelope.expiresAt).getTime() <= now
		) {
			return false;
		}
		const decodedSignature = decodeBase64Url(
			signature,
			"Controller signature",
			86,
		);
		if (decodedSignature.length !== 64) return false;
		return verify(
			null,
			controllerJobSigningInput(unsigned),
			createPublicKey(publicKeyPem),
			decodedSignature,
		);
	} catch {
		return false;
	}
};
