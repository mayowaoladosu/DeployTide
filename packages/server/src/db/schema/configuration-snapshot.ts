import { relations } from "drizzle-orm";
import {
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { environments } from "./environment";
import {
	environmentVariables,
	secretVersions,
	variableExposure,
} from "./environment-variable";
import { projects } from "./project";

export const configurationSnapshots = pgTable(
	"configurationSnapshot",
	{
		configurationSnapshotId: text("configurationSnapshotId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "restrict" }),
		projectId: text("projectId")
			.notNull()
			.references(() => projects.projectId, { onDelete: "restrict" }),
		environmentId: text("environmentId")
			.notNull()
			.references(() => environments.environmentId, { onDelete: "restrict" }),
		serviceType: text("serviceType").notNull(),
		serviceId: text("serviceId").notNull(),
		schemaVersion: integer("schemaVersion").notNull().default(1),
		sourceConfig: jsonb("sourceConfig")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		buildConfig: jsonb("buildConfig")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		runtimeConfig: jsonb("runtimeConfig")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		contentDigest: text("contentDigest").notNull(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("configuration_snapshot_id_ownership_unique").on(
			table.configurationSnapshotId,
			table.organizationId,
			table.projectId,
			table.environmentId,
		),
		uniqueIndex("configuration_snapshot_id_organization_unique").on(
			table.configurationSnapshotId,
			table.organizationId,
		),
		index("configuration_snapshot_environment_created_idx").on(
			table.environmentId,
			table.createdAt,
		),
		index("configuration_snapshot_service_idx").on(
			table.serviceType,
			table.serviceId,
			table.createdAt,
		),
		foreignKey({
			name: "configuration_snapshot_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [projects.projectId, projects.organizationId],
		}).onDelete("restrict"),
		foreignKey({
			name: "configuration_snapshot_environment_ownership_fk",
			columns: [table.environmentId, table.projectId, table.organizationId],
			foreignColumns: [
				environments.environmentId,
				environments.projectId,
				environments.organizationId,
			],
		}).onDelete("restrict"),
	],
);

export const configurationSnapshotSecretVersions = pgTable(
	"configurationSnapshotSecretVersion",
	{
		configurationSnapshotId: text("configurationSnapshotId").notNull(),
		organizationId: text("organizationId").notNull(),
		environmentVariableId: text("environmentVariableId").notNull(),
		secretVersionId: text("secretVersionId").notNull(),
		key: text("key").notNull(),
		exposure: variableExposure("exposure").notNull(),
	},
	(table) => [
		primaryKey({
			name: "configuration_snapshot_secret_key_pk",
			columns: [table.configurationSnapshotId, table.key],
		}),
		uniqueIndex("configuration_snapshot_secret_version_unique").on(
			table.configurationSnapshotId,
			table.secretVersionId,
		),
		index("configuration_snapshot_secret_version_idx").on(
			table.secretVersionId,
		),
		foreignKey({
			name: "configuration_snapshot_secret_snapshot_fk",
			columns: [table.configurationSnapshotId, table.organizationId],
			foreignColumns: [
				configurationSnapshots.configurationSnapshotId,
				configurationSnapshots.organizationId,
			],
		}).onDelete("cascade"),
		foreignKey({
			name: "configuration_snapshot_secret_variable_fk",
			columns: [table.environmentVariableId, table.organizationId],
			foreignColumns: [
				environmentVariables.environmentVariableId,
				environmentVariables.organizationId,
			],
		}).onDelete("restrict"),
		foreignKey({
			name: "configuration_snapshot_secret_exact_version_fk",
			columns: [table.secretVersionId, table.environmentVariableId],
			foreignColumns: [
				secretVersions.secretVersionId,
				secretVersions.environmentVariableId,
			],
		}).onDelete("restrict"),
	],
);

export const configurationSnapshotRelations = relations(
	configurationSnapshots,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [configurationSnapshots.organizationId],
			references: [organization.id],
		}),
		project: one(projects, {
			fields: [configurationSnapshots.projectId],
			references: [projects.projectId],
		}),
		environment: one(environments, {
			fields: [configurationSnapshots.environmentId],
			references: [environments.environmentId],
		}),
		secretVersions: many(configurationSnapshotSecretVersions),
	}),
);

export const configurationSnapshotSecretVersionRelations = relations(
	configurationSnapshotSecretVersions,
	({ one }) => ({
		snapshot: one(configurationSnapshots, {
			fields: [configurationSnapshotSecretVersions.configurationSnapshotId],
			references: [configurationSnapshots.configurationSnapshotId],
		}),
		variable: one(environmentVariables, {
			fields: [configurationSnapshotSecretVersions.environmentVariableId],
			references: [environmentVariables.environmentVariableId],
		}),
		secretVersion: one(secretVersions, {
			fields: [configurationSnapshotSecretVersions.secretVersionId],
			references: [secretVersions.secretVersionId],
		}),
	}),
);
