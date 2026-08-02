import { decryptValue, encryptValue } from "@dokploy/server/lib/encryption";
import { generatePassword } from "@dokploy/server/templates";
import { faker } from "@faker-js/faker";
import { customType } from "drizzle-orm/pg-core";
import { customAlphabet } from "nanoid";

/**
 * Text column encrypted at rest with the versioned encryption keyring.
 * Legacy plaintext values are passed through during migration, but malformed
 * or undecryptable authenticated ciphertext fails closed.
 */
export const encryptedText = customType<{ data: string; driverData: string }>({
	dataType() {
		return "text";
	},
	toDriver(value) {
		return encryptValue(value);
	},
	fromDriver(value) {
		return decryptValue(value);
	},
});

export const encryptedJson = <T>(name: string) =>
	customType<{ data: T; driverData: string }>({
		dataType() {
			return "jsonb";
		},
		toDriver(value) {
			return JSON.stringify(encryptValue(JSON.stringify(value)));
		},
		fromDriver(value) {
			if (typeof value !== "string") {
				if (process.env.DEPLOYTIDE_LEGACY_DECRYPTION === "disabled") {
					throw new Error(
						"Refusing plaintext JSON after the legacy encryption migration window was disabled.",
					);
				}
				return value as T;
			}
			return JSON.parse(decryptValue(value)) as T;
		},
	})(name);

const alphabet = "abcdefghijklmnopqrstuvwxyz123456789";

const customNanoid = customAlphabet(alphabet, 6);

/** App name: letters, numbers, dots, underscores, hyphens only (no spaces). Safe for shell/Docker. */
export const APP_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

export const APP_NAME_MESSAGE =
	"App name can only contain letters, numbers, dots, underscores and hyphens";

/** Docker volume name: must start alphanumeric, then letters/numbers/._- only. Safe for shell. */
export const VOLUME_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export const VOLUME_NAME_MESSAGE =
	"Volume name must start with a letter or number and contain only letters, numbers, dots, underscores and hyphens";

/** Database password: blocks shell-dangerous characters like $ ! ' " \ / and spaces. */
export const DATABASE_PASSWORD_REGEX =
	/^[a-zA-Z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~`]*$/;

export const DATABASE_PASSWORD_MESSAGE =
	"Password contains invalid characters. Please avoid: $ ! ' \" \\ / and space characters for database compatibility";

export const generateAppName = (type: string) => {
	const verb = faker.hacker.verb().replace(/ /g, "-");
	const adjective = faker.hacker.adjective().replace(/ /g, "-");
	const noun = faker.hacker.noun().replace(/ /g, "-");
	const randomFakerElement = `${verb}-${adjective}-${noun}`;
	const nanoidPart = customNanoid();
	return `${type}-${randomFakerElement}-${nanoidPart}`;
};

export const cleanAppName = (appName?: string) => {
	if (!appName) {
		return appName?.toLowerCase();
	}
	return appName.trim().replace(/ /g, "-").toLowerCase();
};

export const buildAppName = (type: string, baseAppName?: string) => {
	if (baseAppName) {
		return `${cleanAppName(baseAppName)}-${generatePassword(6)}`;
	}
	return generateAppName(type);
};
