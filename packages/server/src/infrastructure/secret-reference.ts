import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

const opaqueSecretIdPattern = /^[a-z][a-z0-9_-]{2,63}$/;
const envNamePattern = /^[A-Z][A-Z0-9_]{1,127}$/;

const configuredSecretReferences = () => {
	const raw = process.env.DEPLOYTIDE_OPERATOR_SECRET_REFERENCES;
	if (!raw) return new Map<string, string>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Operator secret reference mapping is invalid");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Operator secret reference mapping is invalid");
	}
	const entries = Object.entries(parsed);
	if (entries.length > 128) {
		throw new Error("Operator secret reference mapping is too large");
	}
	const mapping = new Map<string, string>();
	for (const [id, reference] of entries) {
		if (
			!opaqueSecretIdPattern.test(id) ||
			typeof reference !== "string" ||
			reference.length > 1_024 ||
			(!reference.startsWith("env://") && !reference.startsWith("file://"))
		) {
			throw new Error("Operator secret reference mapping is invalid");
		}
		mapping.set(id, reference);
	}
	return mapping;
};

const configuredFileRoots = () => {
	const raw = process.env.DEPLOYTIDE_OPERATOR_SECRET_FILE_ROOTS ?? "";
	const roots = raw
		.split(path.delimiter)
		.map((root) => root.trim())
		.filter(Boolean)
		.map((root) => {
			if (!path.isAbsolute(root)) {
				throw new Error("Operator secret file root must be absolute");
			}
			return path.resolve(root);
		});
	if (roots.length > 32) {
		throw new Error("Too many operator secret file roots are configured");
	}
	return roots;
};

const isInsideRoot = (candidate: string, root: string) => {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
};

export const assertOperatorSecretId = (secretId: string) => {
	if (!opaqueSecretIdPattern.test(secretId)) {
		throw new Error("Operator secret ID is invalid");
	}
	if (!configuredSecretReferences().has(secretId)) {
		throw new Error("Operator secret ID is unavailable");
	}
	return secretId;
};

export const resolveOperatorSecretReference = async (
	secretId: string | null | undefined,
): Promise<string | null> => {
	if (!secretId) return null;
	assertOperatorSecretId(secretId);
	const reference = configuredSecretReferences().get(secretId);
	if (!reference) throw new Error("Operator secret ID is unavailable");
	if (reference.startsWith("env://")) {
		const name = reference.slice("env://".length);
		if (!envNamePattern.test(name)) {
			throw new Error("Operator secret environment mapping is invalid");
		}
		const value = process.env[name];
		if (!value) throw new Error("Operator secret is unavailable");
		return value;
	}
	const configuredPath = reference.slice("file://".length);
	if (!path.isAbsolute(configuredPath)) {
		throw new Error("Operator secret file mapping must be absolute");
	}
	const filePath = await realpath(path.resolve(configuredPath));
	const roots = await Promise.all(
		configuredFileRoots().map((root) => realpath(root)),
	);
	if (
		roots.length === 0 ||
		!roots.some((root) => isInsideRoot(filePath, root))
	) {
		throw new Error("Operator secret file mapping is outside configured roots");
	}
	const value = (await readFile(filePath, "utf8")).trim();
	if (!value) throw new Error("Operator secret is unavailable");
	return value;
};

export const hasOperatorSecretReference = (
	secretId: string | null | undefined,
) => Boolean(secretId);

export interface ControllerCertificateEnrollment {
	certificateSecretId: string;
	privateKeySecretId: string;
	caFingerprint: string;
}

export const resolveControllerCertificateEnrollment = async (
	enrollmentId: string,
) => {
	if (!opaqueSecretIdPattern.test(enrollmentId)) {
		throw new Error("Controller certificate enrollment ID is invalid");
	}
	const raw = process.env.DEPLOYTIDE_CONTROLLER_CERTIFICATE_ENROLLMENTS;
	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		throw new Error("Controller certificate enrollment mapping is invalid");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Controller certificate enrollment mapping is invalid");
	}
	const enrollment = (parsed as Record<string, unknown>)[enrollmentId];
	if (
		!enrollment ||
		typeof enrollment !== "object" ||
		Array.isArray(enrollment)
	) {
		throw new Error("Controller certificate enrollment ID is unavailable");
	}
	const keys = Object.keys(enrollment);
	if (
		keys.length !== 3 ||
		!keys.every((key) =>
			["certificateSecretId", "privateKeySecretId", "caFingerprint"].includes(
				key,
			),
		)
	) {
		throw new Error("Controller certificate enrollment mapping is invalid");
	}
	const value = enrollment as Partial<ControllerCertificateEnrollment>;
	if (
		typeof value.certificateSecretId !== "string" ||
		typeof value.privateKeySecretId !== "string" ||
		typeof value.caFingerprint !== "string" ||
		!/^sha256:[a-f0-9]{64}$/i.test(value.caFingerprint)
	) {
		throw new Error("Controller certificate enrollment mapping is invalid");
	}
	assertOperatorSecretId(value.certificateSecretId);
	assertOperatorSecretId(value.privateKeySecretId);
	return {
		certificatePem: await resolveOperatorSecretReference(
			value.certificateSecretId,
		),
		privateKeyReference: `operator-secret-id://${value.privateKeySecretId}`,
		caFingerprint: value.caFingerprint.toLowerCase(),
	};
};
