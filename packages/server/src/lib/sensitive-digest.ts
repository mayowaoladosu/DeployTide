import { createHmac } from "node:crypto";

const resolveDigestKey = () => {
	const key = process.env.DEPLOYTIDE_SECRET_DIGEST_KEY;
	if (key) return key;
	if (
		process.env.NODE_ENV === "production" &&
		process.env.DEPLOYTIDE_BUILD !== "true"
	) {
		throw new Error("DEPLOYTIDE_SECRET_DIGEST_KEY is required in production");
	}
	return process.env.ENCRYPTION_KEY || "deploytide-development-digest-key";
};

export const digestSensitiveValue = (purpose: string, value: string) =>
	createHmac("sha256", resolveDigestKey())
		.update(`deploytide:${purpose}:v1`)
		.update(value)
		.digest("hex");

export const digestDeploymentToken = (value: string) =>
	digestSensitiveValue("deployment-token", value);

export const digestSecretValue = (value: string) =>
	digestSensitiveValue("secret-digest", value);
