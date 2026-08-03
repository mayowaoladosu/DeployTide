import type { NextApiRequest } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";

const findCertificate = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", async () => {
	const actual =
		await vi.importActual<typeof import("node:crypto")>("node:crypto");
	return {
		...actual,
		X509Certificate: class {
			fingerprint256 = Array.from({ length: 32 }, () => "AA").join(":");
			subjectAltName =
				"DNS:controller-a, URI:spiffe://deploytide/runtime-cluster/cluster-a/runtime-target/target-a";
		},
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { controllerCertificates: { findFirst: findCertificate } },
	},
}));

vi.mock("@dokploy/server/db/schema", () => ({
	controllerCertificates: {
		runtimeClusterId: "runtimeClusterId",
		serialNumber: "serialNumber",
		subject: "subject",
		status: "status",
		notBefore: "notBefore",
		notAfter: "notAfter",
		revokedAt: "revokedAt",
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions) => conditions),
	eq: vi.fn((...values) => values),
	gt: vi.fn((...values) => values),
	inArray: vi.fn((...values) => values),
	isNull: vi.fn((...values) => values),
	lte: vi.fn((...values) => values),
}));

import {
	authorizeRuntimeControllerRequest,
	CONTROLLER_FINGERPRINT_HEADER,
	CONTROLLER_PROXY_HEADER,
	CONTROLLER_SERIAL_HEADER,
	CONTROLLER_SUBJECT_HEADER,
} from "@/server/controller-auth";

const request = (headers: Record<string, string> = {}) =>
	({ headers }) as unknown as NextApiRequest;

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe("controller ingress authentication", () => {
	it("rejects direct requests missing the trusted proxy identity headers", async () => {
		vi.stubEnv("DEPLOYTIDE_CONTROLLER_PROXY_SECRET", "proxy-secret");
		await expect(
			authorizeRuntimeControllerRequest(request(), "cluster-a", "target-a"),
		).rejects.toThrow("authentication failed");
		expect(findCertificate).not.toHaveBeenCalled();
	});

	it("requires and verifies serial, subject, and SHA-256 certificate fingerprint", async () => {
		vi.stubEnv("DEPLOYTIDE_CONTROLLER_PROXY_SECRET", "proxy-secret");
		findCertificate.mockResolvedValue({ certificatePem: "test-certificate" });
		const fingerprint = "a".repeat(64);
		await expect(
			authorizeRuntimeControllerRequest(
				request({
					[CONTROLLER_PROXY_HEADER]: "proxy-secret",
					[CONTROLLER_SERIAL_HEADER]: "A10B",
					[CONTROLLER_SUBJECT_HEADER]: "CN=controller-a",
					[CONTROLLER_FINGERPRINT_HEADER]: fingerprint,
				}),
				"cluster-a",
				"target-a",
			),
		).resolves.toBeUndefined();
		expect(findCertificate).toHaveBeenCalledOnce();
	});

	it("rejects an invalid or unregistered fingerprint", async () => {
		vi.stubEnv("DEPLOYTIDE_CONTROLLER_PROXY_SECRET", "proxy-secret");
		findCertificate.mockResolvedValue({ certificatePem: "test-certificate" });
		await expect(
			authorizeRuntimeControllerRequest(
				request({
					[CONTROLLER_PROXY_HEADER]: "proxy-secret",
					[CONTROLLER_SERIAL_HEADER]: "A10B",
					[CONTROLLER_SUBJECT_HEADER]: "CN=controller-a",
					[CONTROLLER_FINGERPRINT_HEADER]: "b".repeat(64),
				}),
				"cluster-a",
				"target-a",
			),
		).rejects.toThrow("authentication failed");
	});

	it("rejects a certificate bound to a sibling runtime target", async () => {
		vi.stubEnv("DEPLOYTIDE_CONTROLLER_PROXY_SECRET", "proxy-secret");
		findCertificate.mockResolvedValue({ certificatePem: "test-certificate" });
		await expect(
			authorizeRuntimeControllerRequest(
				request({
					[CONTROLLER_PROXY_HEADER]: "proxy-secret",
					[CONTROLLER_SERIAL_HEADER]: "A10B",
					[CONTROLLER_SUBJECT_HEADER]: "CN=controller-a",
					[CONTROLLER_FINGERPRINT_HEADER]: "a".repeat(64),
				}),
				"cluster-a",
				"target-b",
			),
		).rejects.toThrow("authentication failed");
	});
});
