import { assertSafeOperatorAuditMetadata } from "@dokploy/server";
import { describe, expect, it } from "vitest";

describe("operator audit metadata", () => {
	it("accepts concise redacted lifecycle facts", () => {
		expect(() =>
			assertSafeOperatorAuditMetadata({
				adapterType: "layerrail-compute",
				regionCount: 2,
				complete: true,
			}),
		).not.toThrow();
	});

	it.each([
		["secretReference", "opaque"],
		["endpoint", "internal"],
		["privateKey", "redacted"],
		["certificatePem", "redacted"],
		["payload", "redacted"],
	])("rejects forbidden field %s", (key, value) => {
		expect(() => assertSafeOperatorAuditMetadata({ [key]: value })).toThrow(
			/not safe/i,
		);
	});

	it.each([
		"env://PROVIDER_TOKEN",
		"file:///run/secrets/provider",
		"Bearer private-value",
		"password=private-value",
		"-----BEGIN PRIVATE KEY-----",
	])("rejects secret-like metadata values", (value) => {
		expect(() => assertSafeOperatorAuditMetadata({ note: value })).toThrow(
			/not safe/i,
		);
	});
});
