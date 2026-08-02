import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
} from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { betterAuthSecret } from "./auth-secret";
import { encryptionSecret } from "./encryption-secret";

export const ENCRYPTION_KEY_BACKUP_FILE = "encryption.key";

const LEGACY_ENCRYPTION_PREFIX = "enc:v1:";
const ENCRYPTION_PREFIX = "enc:v2:";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const legacyDecryptionSetting = process.env.DEPLOYTIDE_LEGACY_DECRYPTION;
if (
	legacyDecryptionSetting &&
	!["enabled", "disabled"].includes(legacyDecryptionSetting)
) {
	throw new Error(
		"DEPLOYTIDE_LEGACY_DECRYPTION must be either enabled or disabled",
	);
}
if (
	process.env.NODE_ENV === "production" &&
	process.env.DEPLOYTIDE_BUILD !== "true" &&
	!legacyDecryptionSetting
) {
	throw new Error(
		"DEPLOYTIDE_LEGACY_DECRYPTION must be explicitly enabled during migration or disabled afterward",
	);
}
const legacyDecryptionEnabled = legacyDecryptionSetting !== "disabled";

const deriveLegacyKey = (secret: string) =>
	createHmac("sha256", secret).update("dokploy:db-encryption:v1").digest();

const deriveKey = (keyId: string, secret: string) =>
	createHmac("sha256", secret)
		.update(`deploytide:db-encryption:v2:${keyId}`)
		.digest();

const activeKeyId =
	process.env.ENCRYPTION_KEY_ID?.trim() ||
	(encryptionSecret ? "primary" : "auth");
if (!/^[A-Za-z0-9._-]{1,64}$/.test(activeKeyId)) {
	throw new Error("ENCRYPTION_KEY_ID contains invalid characters");
}

const configuredSecrets = new Map<string, string>();
if (process.env.DEPLOYTIDE_ENCRYPTION_KEYRING) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(process.env.DEPLOYTIDE_ENCRYPTION_KEYRING);
	} catch {
		throw new Error("DEPLOYTIDE_ENCRYPTION_KEYRING must be valid JSON");
	}
	if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
		throw new Error("DEPLOYTIDE_ENCRYPTION_KEYRING must be a JSON object");
	}
	for (const [keyId, secret] of Object.entries(parsed)) {
		if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || typeof secret !== "string") {
			throw new Error("DEPLOYTIDE_ENCRYPTION_KEYRING contains an invalid key");
		}
		configuredSecrets.set(keyId, secret);
	}
}
configuredSecrets.set(activeKeyId, encryptionSecret ?? betterAuthSecret);
if (
	encryptionSecret &&
	legacyDecryptionEnabled &&
	!configuredSecrets.has("auth")
) {
	configuredSecrets.set("auth", betterAuthSecret);
}

const encryptionKeys = new Map(
	[...configuredSecrets].map(([keyId, secret]) => [
		keyId,
		deriveKey(keyId, secret),
	]),
);
const primaryKey = encryptionKeys.get(activeKeyId);
if (!primaryKey) throw new Error("Active encryption key is unavailable");

// Installs that adopt a dedicated ENCRYPTION_KEY still hold values encrypted
// with the auth-secret-derived key; keep it as a decrypt fallback so they
// lazily re-encrypt on the next write instead of becoming unreadable.
const legacyDecryptionKeys = legacyDecryptionEnabled
	? encryptionSecret
		? [deriveLegacyKey(encryptionSecret), deriveLegacyKey(betterAuthSecret)]
		: [deriveLegacyKey(betterAuthSecret)]
	: [];

// Derived keys only — never the raw secrets. A leaked key can decrypt
// stored values, but the raw BETTER_AUTH_SECRET could also forge sessions.
export const exportEncryptionKeys = () =>
	[
		...[...encryptionKeys].map(
			([keyId, key]) => `v2:${keyId}:${key.toString("hex")}`,
		),
		...legacyDecryptionKeys.map((key) => `v1:${key.toString("hex")}`),
	].join("\n");

interface RestoredKeys {
	v2: Map<string, Buffer>;
	v1: Buffer[];
}

let restoredKeys: RestoredKeys | undefined;

// A backup created with "include encryption key" places the original
// server's keys at BASE_PATH when restored; use them as a last-resort
// decryption fallback so restored values keep working on the new server.
const loadRestoredKeys = (): RestoredKeys => {
	if (restoredKeys) {
		return restoredKeys;
	}
	const loaded: RestoredKeys = { v2: new Map(), v1: [] };
	try {
		const { BASE_PATH } = paths();
		const keyPath = join(BASE_PATH, ENCRYPTION_KEY_BACKUP_FILE);
		const keyStats = lstatSync(keyPath);
		if (!keyStats.isFile() || keyStats.isSymbolicLink()) {
			throw new Error("Restored encryption key path must be a regular file");
		}
		if (process.platform !== "win32" && (keyStats.mode & 0o077) !== 0) {
			throw new Error(
				"Restored encryption key file must not be accessible by group or other users",
			);
		}
		const lines = readFileSync(
			keyPath,
			"utf8",
		)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		for (const line of lines) {
			const v2 = /^v2:([A-Za-z0-9._-]{1,64}):([0-9a-f]{64})$/.exec(line);
			if (v2?.[1] && v2[2]) {
				if (!encryptionKeys.has(v2[1])) {
					loaded.v2.set(v2[1], Buffer.from(v2[2], "hex"));
				}
				continue;
			}
			const legacyHex = line.startsWith("v1:") ? line.slice(3) : line;
			if (/^[0-9a-f]{64}$/.test(legacyHex)) {
				const key = Buffer.from(legacyHex, "hex");
				if (!legacyDecryptionKeys.some((own) => own.equals(key))) {
					loaded.v1.push(key);
				}
			}
		}
	} catch {
		// No restored key file present.
	}
	restoredKeys = loaded;
	return loaded;
};

export const isEncrypted = (value: string) =>
	value.startsWith(ENCRYPTION_PREFIX) ||
	value.startsWith(LEGACY_ENCRYPTION_PREFIX);

export const activeEncryptionKeyId = activeKeyId;

const encryptPlaintext = (value: string): string => {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv("aes-256-gcm", primaryKey, iv);
	const encrypted = Buffer.concat([
		cipher.update(value, "utf8"),
		cipher.final(),
	]);
	return `${ENCRYPTION_PREFIX}${activeKeyId}:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
};

export const encryptValue = (value: string): string => {
	if (!value || isEncrypted(value)) {
		return value;
	}
	return encryptPlaintext(value);
};

export const decryptValue = (value: string): string => {
	if (!value) {
		return value;
	}
	if (!isEncrypted(value)) {
		if (legacyDecryptionEnabled) return value;
		throw new Error(
			"Refusing a plaintext value after the legacy encryption migration window was disabled.",
		);
	}
	let keys: Buffer[];
	let encodedPayload: string;
	if (value.startsWith(ENCRYPTION_PREFIX)) {
		const separator = value.indexOf(":", ENCRYPTION_PREFIX.length);
		if (separator === -1) throw new Error("Invalid encrypted value format");
		const keyId = value.slice(ENCRYPTION_PREFIX.length, separator);
		encodedPayload = value.slice(separator + 1);
		const restored = loadRestoredKeys();
		const key = encryptionKeys.get(keyId) ?? restored.v2.get(keyId);
		keys = key ? [key] : [];
	} else {
		encodedPayload = value.slice(LEGACY_ENCRYPTION_PREFIX.length);
		keys = legacyDecryptionEnabled
			? [...legacyDecryptionKeys, ...loadRestoredKeys().v1]
			: [];
	}
	const payload = Buffer.from(encodedPayload, "base64");
	if (payload.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
		throw new Error("Invalid encrypted value payload");
	}
	const iv = payload.subarray(0, IV_LENGTH);
	const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
	const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
	for (const key of keys) {
		try {
			const decipher = createDecipheriv("aes-256-gcm", key, iv);
			decipher.setAuthTag(authTag);
			return Buffer.concat([
				decipher.update(encrypted),
				decipher.final(),
			]).toString("utf8");
		} catch {
			// GCM auth failed for this key; try the next one.
		}
	}
	throw new Error(
		"Failed to decrypt a stored secret. The configured encryption keyring does not contain the required authenticated key.",
	);
};

export const isActiveEncryptionValue = (value: string): boolean =>
	value.startsWith(`${ENCRYPTION_PREFIX}${activeKeyId}:`);

/** Decrypts any allowed legacy value and always emits active-key v2 ciphertext. */
export const rotateEncryptionValue = (value: string): string => {
	if (!value) return value;
	return encryptPlaintext(decryptValue(value));
};

/**
 * Re-encrypts a value in the Phase 1 format before an emergency code cutback.
 * This must never be used for forward writes.
 */
export const encryptLegacyValueForCutback = (value: string): string => {
	if (!value) return value;
	if (process.env.DEPLOYTIDE_ALLOW_ENCRYPTION_CUTBACK !== "true") {
		throw new Error(
			"DEPLOYTIDE_ALLOW_ENCRYPTION_CUTBACK=true is required for legacy re-encryption",
		);
	}
	const plaintext = decryptValue(value);
	const legacyKey = deriveLegacyKey(encryptionSecret ?? betterAuthSecret);
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
	const encrypted = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	return `${LEGACY_ENCRYPTION_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
};
