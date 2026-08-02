import fs from "node:fs";

export const {
	DATABASE_URL,
	POSTGRES_PASSWORD_FILE,
	POSTGRES_USER = "dokploy",
	POSTGRES_DB = "dokploy",
	POSTGRES_HOST = "dokploy-postgres",
	POSTGRES_PORT = "5432",
} = process.env;

export function readSecret(path: string): string {
	try {
		return fs.readFileSync(path, "utf8").trim();
	} catch {
		throw new Error(`Cannot read secret at ${path}`);
	}
}
export let dbUrl: string;
if (DATABASE_URL) {
	// Compatibilidad legacy / overrides
	dbUrl = DATABASE_URL;
} else if (POSTGRES_PASSWORD_FILE) {
	const password = readSecret(POSTGRES_PASSWORD_FILE);
	dbUrl = `postgres://${POSTGRES_USER}:${encodeURIComponent(
		password,
	)}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`;
} else {
	if (process.env.NODE_ENV === "production") {
		throw new Error(
			"DATABASE_URL or POSTGRES_PASSWORD_FILE is required in production",
		);
	}
	dbUrl =
		"postgres://dokploy:amukds4wi9001583845717ad2@localhost:5432/dokploy";
}
