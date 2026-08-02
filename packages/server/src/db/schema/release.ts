import { relations } from "drizzle-orm";
import {
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { artifacts } from "./artifact";
import { configurationSnapshots } from "./configuration-snapshot";
import { deployments } from "./deployment";
import { environments } from "./environment";
import { operations } from "./operation";
import { projects } from "./project";

export const releaseStatus = pgEnum("releaseStatus", [
	"queued",
	"deploying",
	"checking",
	"ready",
	"failed",
	"cancelled",
	"retired",
]);

export const releases = pgTable(
	"release",
	{
		releaseId: text("releaseId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("projectId")
			.notNull()
			.references(() => projects.projectId, { onDelete: "cascade" }),
		environmentId: text("environmentId")
			.notNull()
			.references(() => environments.environmentId, { onDelete: "cascade" }),
		deploymentId: text("deploymentId")
			.notNull()
			.references(() => deployments.deploymentId, { onDelete: "cascade" }),
		artifactId: text("artifactId")
			.notNull()
			.references(() => artifacts.artifactId, { onDelete: "restrict" }),
		operationId: text("operationId").references(
			() => operations.operationId,
			{ onDelete: "set null" },
		),
		configurationSnapshotId: text("configurationSnapshotId")
			.notNull()
			.references(() => configurationSnapshots.configurationSnapshotId, {
				onDelete: "restrict",
			}),
		status: releaseStatus("status").notNull().default("queued"),
		attempt: integer("attempt").notNull().default(1),
		runtimeConfigVersion: text("runtimeConfigVersion").notNull(),
		runtimePlacementId: text("runtimePlacementId"),
		serviceIdentity: text("serviceIdentity").notNull(),
		healthResult: jsonb("healthResult").$type<Record<string, unknown>>(),
		failureCode: text("failureCode"),
		failureMessage: text("failureMessage"),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		deployingAt: timestamp("deployingAt", { withTimezone: true }),
		readyAt: timestamp("readyAt", { withTimezone: true }),
		failedAt: timestamp("failedAt", { withTimezone: true }),
		retiredAt: timestamp("retiredAt", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("release_deployment_attempt_unique").on(
			table.deploymentId,
			table.attempt,
		),
		uniqueIndex("release_service_identity_unique").on(table.serviceIdentity),
		uniqueIndex("release_id_organization_project_environment_unique").on(
			table.releaseId,
			table.organizationId,
			table.projectId,
			table.environmentId,
		),
		uniqueIndex("release_id_organization_unique").on(
			table.releaseId,
			table.organizationId,
		),
		index("release_environment_status_idx").on(
			table.environmentId,
			table.status,
		),
		index("release_artifact_idx").on(table.artifactId),
		index("release_configuration_snapshot_idx").on(
			table.configurationSnapshotId,
		),
		foreignKey({
			name: "release_configuration_snapshot_ownership_fk",
			columns: [
				table.configurationSnapshotId,
				table.organizationId,
				table.projectId,
				table.environmentId,
			],
			foreignColumns: [
				configurationSnapshots.configurationSnapshotId,
				configurationSnapshots.organizationId,
				configurationSnapshots.projectId,
				configurationSnapshots.environmentId,
			],
		}).onDelete("restrict"),
		foreignKey({
			name: "release_project_organization_fk",
			columns: [table.projectId, table.organizationId],
			foreignColumns: [projects.projectId, projects.organizationId],
		}).onDelete("cascade"),
		foreignKey({
			name: "release_environment_project_organization_fk",
			columns: [table.environmentId, table.projectId, table.organizationId],
			foreignColumns: [
				environments.environmentId,
				environments.projectId,
				environments.organizationId,
			],
		}).onDelete("cascade"),
		foreignKey({
			name: "release_deployment_ownership_fk",
			columns: [
				table.deploymentId,
				table.organizationId,
				table.projectId,
				table.environmentId,
			],
			foreignColumns: [
				deployments.deploymentId,
				deployments.organizationId,
				deployments.projectId,
				deployments.environmentId,
			],
		}).onDelete("cascade"),
		foreignKey({
			name: "release_artifact_ownership_fk",
			columns: [table.artifactId, table.organizationId, table.projectId],
			foreignColumns: [
				artifacts.artifactId,
				artifacts.organizationId,
				artifacts.projectId,
			],
		}).onDelete("restrict"),
	],
);

export const releaseRelations = relations(releases, ({ one }) => ({
	organization: one(organization, {
		fields: [releases.organizationId],
		references: [organization.id],
	}),
	project: one(projects, {
		fields: [releases.projectId],
		references: [projects.projectId],
	}),
	environment: one(environments, {
		fields: [releases.environmentId],
		references: [environments.environmentId],
	}),
	deployment: one(deployments, {
		fields: [releases.deploymentId],
		references: [deployments.deploymentId],
	}),
	artifact: one(artifacts, {
		fields: [releases.artifactId],
		references: [artifacts.artifactId],
	}),
	operation: one(operations, {
		fields: [releases.operationId],
		references: [operations.operationId],
	}),
	configurationSnapshot: one(configurationSnapshots, {
		fields: [releases.configurationSnapshotId],
		references: [configurationSnapshots.configurationSnapshotId],
	}),
}));
