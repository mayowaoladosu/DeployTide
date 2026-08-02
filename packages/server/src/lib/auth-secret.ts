import { readSecret } from "../db/constants";

const DEVELOPMENT_SECRET = "deploytide-development-only-auth-secret";

const { BETTER_AUTH_SECRET, BETTER_AUTH_SECRET_FILE } = process.env;

function resolveBetterAuthSecret(): string {
	if (BETTER_AUTH_SECRET) {
		return BETTER_AUTH_SECRET;
	}
	if (BETTER_AUTH_SECRET_FILE) {
		return readSecret(BETTER_AUTH_SECRET_FILE);
	}
	if (process.env.NODE_ENV === "production") {
		throw new Error(
			"BETTER_AUTH_SECRET or BETTER_AUTH_SECRET_FILE is required in production",
		);
	}
	if (process.env.NODE_ENV !== "test") {
		console.warn(
			"BETTER_AUTH_SECRET is not set; using a development-only secret",
		);
	}
	return DEVELOPMENT_SECRET;
}

export const betterAuthSecret = resolveBetterAuthSecret();
