import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { db } from "@dokploy/server/db";
import { controllerCertificates } from "@dokploy/server/db/schema";
import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { NextApiRequest } from "next";

export const CONTROLLER_PROXY_HEADER = "x-deploytide-controller-proxy";
export const CONTROLLER_SERIAL_HEADER = "x-deploytide-client-serial";
export const CONTROLLER_SUBJECT_HEADER = "x-deploytide-client-subject";
export const CONTROLLER_FINGERPRINT_HEADER = "x-deploytide-client-fingerprint";
export const CONTROLLER_RUNTIME_TARGET_HEADER = "x-deploytide-runtime-target";

const controllerIdentifierPattern = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,191}$/;

export const isControllerIdentifier = (value: unknown): value is string =>
	typeof value === "string" && controllerIdentifierPattern.test(value);

export class ControllerAuthenticationError extends Error {
	constructor() {
		super("Controller authentication failed");
		this.name = "ControllerAuthenticationError";
	}
}

const singleHeader = (value: string | string[] | undefined) =>
	typeof value === "string" ? value : undefined;

const safeEqual = (left: string, right: string) => {
	const leftDigest = createHash("sha256").update(left).digest();
	const rightDigest = createHash("sha256").update(right).digest();
	return timingSafeEqual(leftDigest, rightDigest);
};

const assertSharedSecret = (provided: string | undefined) => {
	const expected = process.env.DEPLOYTIDE_CONTROLLER_PROXY_SECRET;
	if (!expected || !provided || !safeEqual(expected, provided)) {
		throw new ControllerAuthenticationError();
	}
};

export const authorizeRuntimeControllerRequest = async (
	req: NextApiRequest,
	clusterId: string,
	runtimeTargetId: string,
) => {
	const proxySecret = singleHeader(req.headers[CONTROLLER_PROXY_HEADER]);
	const serialNumber = singleHeader(req.headers[CONTROLLER_SERIAL_HEADER]);
	const subject = singleHeader(req.headers[CONTROLLER_SUBJECT_HEADER]);
	const fingerprint = singleHeader(req.headers[CONTROLLER_FINGERPRINT_HEADER]);
	if (
		!proxySecret ||
		!serialNumber ||
		!subject ||
		!fingerprint ||
		!isControllerIdentifier(runtimeTargetId)
	) {
		throw new ControllerAuthenticationError();
	}
	assertSharedSecret(proxySecret);
	if (
		!/^[A-Fa-f0-9]{1,160}$/.test(serialNumber) ||
		subject.length === 0 ||
		subject.length > 240 ||
		!/^(?:sha256:)?[A-Fa-f0-9]{64}$/.test(fingerprint)
	) {
		throw new ControllerAuthenticationError();
	}
	const now = new Date();
	const certificate = await db.query.controllerCertificates.findFirst({
		where: and(
			eq(controllerCertificates.runtimeClusterId, clusterId),
			eq(controllerCertificates.serialNumber, serialNumber),
			eq(controllerCertificates.subject, subject),
			inArray(controllerCertificates.status, ["active", "rotating"]),
			lte(controllerCertificates.notBefore, now),
			gt(controllerCertificates.notAfter, now),
			isNull(controllerCertificates.revokedAt),
		),
		columns: { certificatePem: true },
	});
	if (!certificate) throw new ControllerAuthenticationError();
	try {
		const parsedCertificate = new X509Certificate(certificate.certificatePem);
		const expected = parsedCertificate.fingerprint256
			.replaceAll(":", "")
			.toLowerCase();
		const provided = fingerprint.replace(/^sha256:/i, "").toLowerCase();
		const expectedSubjectAltName = `URI:spiffe://deploytide/runtime-cluster/${clusterId}/runtime-target/${runtimeTargetId}`;
		const subjectAltNames = parsedCertificate.subjectAltName?.split(", ");
		if (
			!safeEqual(expected, provided) ||
			subjectAltNames?.filter((entry) => entry === expectedSubjectAltName)
				.length !== 1
		) {
			throw new ControllerAuthenticationError();
		}
	} catch (error) {
		if (error instanceof ControllerAuthenticationError) throw error;
		throw new ControllerAuthenticationError();
	}
};

export const readControllerSigningPrivateKey = async () => {
	const file = process.env.DEPLOYTIDE_JOB_SIGNING_PRIVATE_KEY_FILE;
	if (!file)
		throw new Error("Controller job signing key file is not configured");
	const privateKey = (await readFile(file, "utf8")).trim();
	if (!privateKey.startsWith("-----BEGIN PRIVATE KEY-----")) {
		throw new Error("Controller job signing key is invalid");
	}
	return privateKey;
};

export const controllerNoStore = {
	"Cache-Control": "no-store",
	"Content-Type": "application/json",
	Pragma: "no-cache",
	"X-Content-Type-Options": "nosniff",
} as const;
