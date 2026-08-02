export interface EncryptedColumn {
	table: string;
	id: string;
	column: string;
	phase1Plaintext?: boolean;
	phase1Json?: boolean;
}

export const encryptedColumns: EncryptedColumn[] = [
	{ table: "project", id: "projectId", column: "env" },
	{ table: "environment", id: "environmentId", column: "env" },
	{ table: "application", id: "applicationId", column: "env" },
	{ table: "application", id: "applicationId", column: "previewEnv" },
	{ table: "application", id: "applicationId", column: "previewBuildArgs" },
	{ table: "application", id: "applicationId", column: "previewBuildSecrets" },
	{ table: "application", id: "applicationId", column: "buildArgs" },
	{ table: "application", id: "applicationId", column: "buildSecrets" },
	{
		table: "application",
		id: "applicationId",
		column: "password",
		phase1Plaintext: true,
	},
	{
		table: "application",
		id: "applicationId",
		column: "refreshToken",
		phase1Plaintext: true,
	},
	{ table: "compose", id: "composeId", column: "env" },
	{
		table: "compose",
		id: "composeId",
		column: "refreshToken",
		phase1Plaintext: true,
	},
	{ table: "postgres", id: "postgresId", column: "env" },
	{ table: "mariadb", id: "mariadbId", column: "env" },
	{ table: "mysql", id: "mysqlId", column: "env" },
	{ table: "mongo", id: "mongoId", column: "env" },
	{ table: "redis", id: "redisId", column: "env" },
	{ table: "libsql", id: "libsqlId", column: "env" },
	{
		table: "postgres",
		id: "postgresId",
		column: "databasePassword",
		phase1Plaintext: true,
	},
	{
		table: "mariadb",
		id: "mariadbId",
		column: "databasePassword",
		phase1Plaintext: true,
	},
	{
		table: "mariadb",
		id: "mariadbId",
		column: "rootPassword",
		phase1Plaintext: true,
	},
	{
		table: "mysql",
		id: "mysqlId",
		column: "databasePassword",
		phase1Plaintext: true,
	},
	{
		table: "mysql",
		id: "mysqlId",
		column: "rootPassword",
		phase1Plaintext: true,
	},
	{
		table: "mongo",
		id: "mongoId",
		column: "databasePassword",
		phase1Plaintext: true,
	},
	{
		table: "redis",
		id: "redisId",
		column: "password",
		phase1Plaintext: true,
	},
	{
		table: "libsql",
		id: "libsqlId",
		column: "databasePassword",
		phase1Plaintext: true,
	},
	{ table: "secretVersion", id: "secretVersionId", column: "value" },
	{ table: "account", id: "id", column: "access_token", phase1Plaintext: true },
	{ table: "account", id: "id", column: "refresh_token", phase1Plaintext: true },
	{ table: "account", id: "id", column: "id_token", phase1Plaintext: true },
	{
		table: "account",
		id: "id",
		column: "resetPasswordToken",
		phase1Plaintext: true,
	},
	{
		table: "account",
		id: "id",
		column: "confirmationToken",
		phase1Plaintext: true,
	},
	{ table: "two_factor", id: "id", column: "secret", phase1Plaintext: true },
	{
		table: "two_factor",
		id: "id",
		column: "backup_codes",
		phase1Plaintext: true,
	},
	{ table: "user", id: "id", column: "licenseKey", phase1Plaintext: true },
	{
		table: "scim_provider",
		id: "id",
		column: "scim_token",
		phase1Plaintext: true,
	},
	{
		table: "github",
		id: "githubId",
		column: "githubClientSecret",
		phase1Plaintext: true,
	},
	{
		table: "github",
		id: "githubId",
		column: "githubPrivateKey",
		phase1Plaintext: true,
	},
	{
		table: "github",
		id: "githubId",
		column: "githubWebhookSecret",
		phase1Plaintext: true,
	},
	{ table: "gitlab", id: "gitlabId", column: "secret", phase1Plaintext: true },
	{
		table: "gitlab",
		id: "gitlabId",
		column: "access_token",
		phase1Plaintext: true,
	},
	{
		table: "gitlab",
		id: "gitlabId",
		column: "refresh_token",
		phase1Plaintext: true,
	},
	{
		table: "gitea",
		id: "giteaId",
		column: "client_secret",
		phase1Plaintext: true,
	},
	{
		table: "gitea",
		id: "giteaId",
		column: "access_token",
		phase1Plaintext: true,
	},
	{
		table: "gitea",
		id: "giteaId",
		column: "refresh_token",
		phase1Plaintext: true,
	},
	{
		table: "bitbucket",
		id: "bitbucketId",
		column: "appPassword",
		phase1Plaintext: true,
	},
	{
		table: "bitbucket",
		id: "bitbucketId",
		column: "apiToken",
		phase1Plaintext: true,
	},
	{ table: "registry", id: "registryId", column: "password", phase1Plaintext: true },
	{
		table: "destination",
		id: "destinationId",
		column: "accessKey",
		phase1Plaintext: true,
	},
	{
		table: "destination",
		id: "destinationId",
		column: "secretAccessKey",
		phase1Plaintext: true,
	},
	{ table: "ai", id: "aiId", column: "apiKey", phase1Plaintext: true },
	{
		table: "certificate",
		id: "certificateId",
		column: "privateKey",
		phase1Plaintext: true,
	},
	{ table: "security", id: "securityId", column: "password", phase1Plaintext: true },
	{ table: "ssh-key", id: "sshKeyId", column: "privateKey", phase1Plaintext: true },
	{
		table: "webServerSettings",
		id: "id",
		column: "sshPrivateKey",
		phase1Plaintext: true,
	},
	{
		table: "webServerSettings",
		id: "id",
		column: "metricsConfig",
		phase1Json: true,
	},
	{ table: "server", id: "serverId", column: "metricsConfig", phase1Json: true },
	{ table: "slack", id: "slackId", column: "webhookUrl", phase1Plaintext: true },
	{ table: "telegram", id: "telegramId", column: "botToken", phase1Plaintext: true },
	{ table: "discord", id: "discordId", column: "webhookUrl", phase1Plaintext: true },
	{ table: "email", id: "emailId", column: "password", phase1Plaintext: true },
	{ table: "resend", id: "resendId", column: "apiKey", phase1Plaintext: true },
	{ table: "gotify", id: "gotifyId", column: "appToken", phase1Plaintext: true },
	{ table: "ntfy", id: "ntfyId", column: "accessToken", phase1Plaintext: true },
	{
		table: "mattermost",
		id: "mattermostId",
		column: "webhookUrl",
		phase1Plaintext: true,
	},
	{ table: "custom", id: "customId", column: "endpoint", phase1Plaintext: true },
	{ table: "custom", id: "customId", column: "headers", phase1Json: true },
	{ table: "lark", id: "larkId", column: "webhookUrl", phase1Plaintext: true },
	{ table: "pushover", id: "pushoverId", column: "userKey", phase1Plaintext: true },
	{ table: "pushover", id: "pushoverId", column: "apiToken", phase1Plaintext: true },
	{ table: "teams", id: "teamsId", column: "webhookUrl", phase1Plaintext: true },
];

export const quoteIdentifier = (value: string) => {
	if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) {
		throw new Error(`Unsafe database identifier: ${value}`);
	}
	return `"${value}"`;
};

export const deploymentTokenColumns = [
	{
		table: "application",
		id: "applicationId",
		tokenColumn: "refreshToken",
		digestColumn: "refreshTokenDigest",
	},
	{
		table: "compose",
		id: "composeId",
		tokenColumn: "refreshToken",
		digestColumn: "refreshTokenDigest",
	},
] as const;
