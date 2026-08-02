import { createDecipheriv, createHmac } from "node:crypto";
import {
	decryptValue,
	encryptValue,
	exportEncryptionKeys,
	isEncrypted,
} from "@dokploy/server/lib/encryption";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("encryptValue / decryptValue", () => {
	it("round-trips a value", () => {
		const value =
			"DATABASE_URL=postgres://user:secret@host:5432/db\nAPI_KEY=123";
		const encrypted = encryptValue(value);

		expect(encrypted).not.toBe(value);
		expect(isEncrypted(encrypted)).toBe(true);
		expect(encrypted).not.toContain("secret");
		expect(decryptValue(encrypted)).toBe(value);
	});

	it("uses a random IV so equal inputs produce different ciphertexts", () => {
		const value = "KEY=value";
		expect(encryptValue(value)).not.toBe(encryptValue(value));
	});

	it("passes legacy plaintext through on decrypt", () => {
		const plaintext = "KEY=legacy-plaintext-value";
		expect(decryptValue(plaintext)).toBe(plaintext);
	});

	it("passes empty values through unchanged", () => {
		expect(encryptValue("")).toBe("");
		expect(decryptValue("")).toBe("");
	});

	it("does not double-encrypt an already encrypted value", () => {
		const encrypted = encryptValue("KEY=value");
		expect(encryptValue(encrypted)).toBe(encrypted);
	});

	it("throws a descriptive error on tampered ciphertext", () => {
		const encrypted = encryptValue("KEY=value");
		const tampered = `${encrypted.slice(0, -4)}AAAA`;
		expect(() => decryptValue(tampered)).toThrow(/keyring/);
	});

	it("exports versioned 32-byte keys for backups", () => {
		expect(exportEncryptionKeys()).toMatch(
			/^(v2:[A-Za-z0-9._-]+|v1):[0-9a-f]{64}(\n(v2:[A-Za-z0-9._-]+|v1):[0-9a-f]{64})*$/,
		);
	});
});

describe("dedicated ENCRYPTION_KEY", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	const loadWithEncryptionKey = async (key: string) => {
		vi.stubEnv("ENCRYPTION_KEY", key);
		vi.stubEnv("ENCRYPTION_KEY_ID", "primary");
		vi.stubEnv("DEPLOYTIDE_ENCRYPTION_KEYRING", "");
		vi.stubEnv("DEPLOYTIDE_LEGACY_DECRYPTION", "enabled");
		vi.resetModules();
		return await import("@dokploy/server/lib/encryption");
	};

	const loadAuthKeyring = async () => {
		vi.stubEnv("ENCRYPTION_KEY", "");
		vi.stubEnv("ENCRYPTION_KEY_ID", "");
		vi.stubEnv("DEPLOYTIDE_ENCRYPTION_KEYRING", "");
		vi.stubEnv("DEPLOYTIDE_LEGACY_DECRYPTION", "enabled");
		vi.resetModules();
		return await import("@dokploy/server/lib/encryption");
	};

	it("encrypts with the dedicated key when set", async () => {
		const withKey = await loadWithEncryptionKey("my-dedicated-key");
		const encrypted = withKey.encryptValue("KEY=value");

		expect(withKey.decryptValue(encrypted)).toBe("KEY=value");
		// The default (auth-secret derived) module cannot read it
		expect(() => decryptValue(encrypted)).toThrow(/keyring/);
	});

	it("still decrypts legacy values via the auth-secret fallback", async () => {
		// Encrypted before the install adopted a dedicated key
		const authKeyring = await loadAuthKeyring();
		const legacyEncrypted = authKeyring.encryptValue("KEY=legacy-value");

		const withKey = await loadWithEncryptionKey("my-dedicated-key");
		expect(withKey.decryptValue(legacyEncrypted)).toBe("KEY=legacy-value");
	});

	it("re-encrypts with the dedicated key on write", async () => {
		const authKeyring = await loadAuthKeyring();
		const withKey = await loadWithEncryptionKey("my-dedicated-key");
		const reEncrypted = withKey.encryptValue(
			withKey.decryptValue(authKeyring.encryptValue("KEY=migrated")),
		);

		const other = await loadWithEncryptionKey("another-key");
		// Readable only by the dedicated key (or its own fallback), proving
		// the write used the primary key, not the legacy one
		expect(withKey.decryptValue(reEncrypted)).toBe("KEY=migrated");
		expect(() => other.decryptValue(reEncrypted)).toThrow();
	});

	it("decrypts a previous v2 key after rotation", async () => {
		vi.stubEnv("ENCRYPTION_KEY", "old-key-secret");
		vi.stubEnv("ENCRYPTION_KEY_ID", "2026-01");
		vi.stubEnv("DEPLOYTIDE_ENCRYPTION_KEYRING", "");
		vi.resetModules();
		const oldKeyring = await import("@dokploy/server/lib/encryption");
		const encrypted = oldKeyring.encryptValue("KEY=rotated");

		vi.stubEnv("ENCRYPTION_KEY", "new-key-secret");
		vi.stubEnv("ENCRYPTION_KEY_ID", "2026-02");
		vi.stubEnv(
			"DEPLOYTIDE_ENCRYPTION_KEYRING",
			JSON.stringify({ "2026-01": "old-key-secret" }),
		);
		vi.resetModules();
		const newKeyring = await import("@dokploy/server/lib/encryption");

		expect(newKeyring.decryptValue(encrypted)).toBe("KEY=rotated");
		expect(newKeyring.encryptValue("KEY=new")).toContain("enc:v2:2026-02:");
	});

	it("fails closed after the legacy migration window is disabled", async () => {
		const authKeyring = await loadAuthKeyring();
		const authDerived = authKeyring.encryptValue("KEY=legacy-auth-key");

		vi.stubEnv("ENCRYPTION_KEY", "dedicated-production-key");
		vi.stubEnv("ENCRYPTION_KEY_ID", "2026-03");
		vi.stubEnv("DEPLOYTIDE_ENCRYPTION_KEYRING", "");
		vi.stubEnv("DEPLOYTIDE_LEGACY_DECRYPTION", "disabled");
		vi.resetModules();
		const strictKeyring = await import("@dokploy/server/lib/encryption");

		const current = strictKeyring.encryptValue("KEY=current");
		expect(strictKeyring.decryptValue(current)).toBe("KEY=current");
		expect(() => strictKeyring.decryptValue(authDerived)).toThrow(/keyring/);
		expect(() => strictKeyring.decryptValue("KEY=plaintext")).toThrow(
			/plaintext/,
		);
	});

	it("requires an explicit legacy-window setting in production", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("DEPLOYTIDE_BUILD", "false");
		vi.stubEnv(
			"DATABASE_URL",
			"postgresql://test:test@127.0.0.1:1/deploytide-test",
		);
		vi.stubEnv("BETTER_AUTH_SECRET", "production-test-auth-secret");
		vi.stubEnv("ENCRYPTION_KEY", "dedicated-production-key");
		vi.stubEnv("ENCRYPTION_KEY_ID", "production");
		vi.stubEnv("DEPLOYTIDE_LEGACY_DECRYPTION", "");
		vi.resetModules();

		await expect(import("@dokploy/server/lib/encryption")).rejects.toThrow(
			/explicitly enabled.*disabled/,
		);
	});

	it("produces Phase 1-compatible ciphertext only with explicit cutback approval", async () => {
		const withKey = await loadWithEncryptionKey("my-dedicated-key");
		const current = withKey.encryptValue("KEY=cutback-compatible");
		expect(() => withKey.encryptLegacyValueForCutback(current)).toThrow(
			/ALLOW_ENCRYPTION_CUTBACK/,
		);

		vi.stubEnv("DEPLOYTIDE_ALLOW_ENCRYPTION_CUTBACK", "true");
		const legacy = withKey.encryptLegacyValueForCutback(current);
		expect(legacy).toMatch(/^enc:v1:/);

		const payload = Buffer.from(legacy.slice("enc:v1:".length), "base64");
		const key = createHmac("sha256", "my-dedicated-key")
			.update("dokploy:db-encryption:v1")
			.digest();
		const decipher = createDecipheriv(
			"aes-256-gcm",
			key,
			payload.subarray(0, 12),
		);
		decipher.setAuthTag(payload.subarray(12, 28));
		const plaintext = Buffer.concat([
			decipher.update(payload.subarray(28)),
			decipher.final(),
		]).toString("utf8");
		expect(plaintext).toBe("KEY=cutback-compatible");
	});
});
