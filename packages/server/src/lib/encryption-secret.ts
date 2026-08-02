import { readSecret } from "../db/constants";

const { ENCRYPTION_KEY, ENCRYPTION_KEY_FILE } = process.env;

function resolveEncryptionSecret(): string | undefined {
	if (ENCRYPTION_KEY) {
		return ENCRYPTION_KEY;
	}
	if (ENCRYPTION_KEY_FILE) {
		return readSecret(ENCRYPTION_KEY_FILE);
	}
	if (
		process.env.NODE_ENV === "production" &&
		process.env.DEPLOYTIDE_BUILD !== "true"
	) {
		throw new Error(
			"ENCRYPTION_KEY or ENCRYPTION_KEY_FILE is required in production",
		);
	}
	return undefined;
}

export const encryptionSecret = resolveEncryptionSecret();
