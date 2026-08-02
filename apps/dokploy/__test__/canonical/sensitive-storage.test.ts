import { encryptedJson } from "@dokploy/server/db/schema/utils";
import {
	digestDeploymentToken,
	digestSecretValue,
} from "@dokploy/server/lib/sensitive-digest";
import { pgTable } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const encryptedJsonProbe = pgTable("encrypted_json_probe", {
	value: encryptedJson<{ token: string }>("value"),
});

describe("sensitive storage helpers", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("uses domain-separated stable keyed digests", () => {
		vi.stubEnv("DEPLOYTIDE_SECRET_DIGEST_KEY", "stable-digest-key");
		const tokenDigest = digestDeploymentToken("low-entropy-token");
		const secretDigest = digestSecretValue("low-entropy-token");

		expect(tokenDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(secretDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(tokenDigest).not.toBe(secretDigest);
		expect(tokenDigest).not.toContain("low-entropy-token");
	});

	it("rejects plaintext JSON after the migration window closes", () => {
		vi.stubEnv("DEPLOYTIDE_LEGACY_DECRYPTION", "disabled");
		expect(() =>
			encryptedJsonProbe.value.mapFromDriverValue({ token: "plaintext" }),
		).toThrow(/plaintext JSON/);
	});

	it("encodes encrypted JSON as a valid JSONB string literal", () => {
		const encoded = encryptedJsonProbe.value.mapToDriverValue({
			token: "sensitive",
		});
		expect(typeof encoded).toBe("string");
		expect(JSON.parse(encoded as string)).toMatch(/^enc:v2:/);
		expect(encoded).not.toContain("sensitive");
	});
});
