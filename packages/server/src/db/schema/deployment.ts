import { relations } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	foreignKey,
	index,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { applications } from "./application";
import { backups } from "./backups";
import { compose } from "./compose";
import { configurationSnapshots } from "./configuration-snapshot";
import { environments } from "./environment";
import { previewDeployments } from "./preview-deployments";
import { projects } from "./project";
import { rollbacks } from "./rollbacks";
import { schedules } from "./schedule";
import { server } from "./server";
import { volumeBackups } from "./volume-backups";
export const deploymentStatus = pgEnum("deploymentStatus", [
	"queued",
	"preparing",
	"building",
	"deploying",
	"checking",
	"ready",
	"failed",
	"cancelling",
	"running",
	"done",
	"error",
	"cancelled",
]);

export const deploymentTrigger = pgEnum("deploymentTrigger", [
	"git_push",
	"git_pull_request",
	"manual",
	"cli",
	"api",
	"import",
	"redeploy",
	"rollback",
	"schedule",
]);

export const deployments = pgTable("deployment", {
	deploymentId: text("deploymentId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId").references(() => organization.id, {
		onDelete: "cascade",
	}),
	projectId: text("projectId").references(() => projects.projectId, {
		onDelete: "cascade",
	}),
	environmentId: text("environmentId").references(
		() => environments.environmentId,
		{ onDelete: "cascade" },
	),
	title: text("title").notNull(),
	description: text("description"),
	status: deploymentStatus("status").default("running"),
	trigger: deploymentTrigger("trigger"),
	sourceProvider: text("sourceProvider"),
	sourceRevision: text("sourceRevision"),
	sourceBranch: text("sourceBranch"),
	sourceAuthor: text("sourceAuthor"),
	sourceMessage: text("sourceMessage"),
	desiredSequence: bigint("desiredSequence", { mode: "number" })
		.notNull()
		.default(0),
	immutableUrl: text("immutableUrl"),
	sourceConfigSnapshot: jsonb("sourceConfigSnapshot").$type<Record<string, unknown>>(),
	buildConfigSnapshot: jsonb("buildConfigSnapshot").$type<Record<string, unknown>>(),
	runtimeConfigSnapshot: jsonb("runtimeConfigSnapshot").$type<Record<string, unknown>>(),
	configurationSnapshotId: text("configurationSnapshotId").references(
		() => configurationSnapshots.configurationSnapshotId,
		{ onDelete: "restrict" },
	),
	logPath: text("logPath").notNull(),
	pid: text("pid"),
	applicationId: text("applicationId").references(
		() => applications.applicationId,
		{ onDelete: "cascade" },
	),
	composeId: text("composeId").references(() => compose.composeId, {
		onDelete: "cascade",
	}),
	serverId: text("serverId").references(() => server.serverId, {
		onDelete: "cascade",
	}),
	isPreviewDeployment: boolean("isPreviewDeployment").default(false),
	previewDeploymentId: text("previewDeploymentId").references(
		(): AnyPgColumn => previewDeployments.previewDeploymentId,
		{ onDelete: "cascade" },
	),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	startedAt: text("startedAt"),
	finishedAt: text("finishedAt"),
	errorMessage: text("errorMessage"),
	errorCode: text("errorCode"),
	deletedAt: timestamp("deletedAt", { withTimezone: true }),
	scheduleId: text("scheduleId").references(
		(): AnyPgColumn => schedules.scheduleId,
		{ onDelete: "cascade" },
	),
	backupId: text("backupId").references((): AnyPgColumn => backups.backupId, {
		onDelete: "cascade",
	}),
	rollbackId: text("rollbackId").references(
		(): AnyPgColumn => rollbacks.rollbackId,
		{ onDelete: "set null" },
	),
	volumeBackupId: text("volumeBackupId").references(
		(): AnyPgColumn => volumeBackups.volumeBackupId,
		{ onDelete: "cascade" },
	),
	buildServerId: text("buildServerId").references(() => server.serverId, {
		onDelete: "cascade",
	}),
}, (table) => [
	index("deployment_org_created_idx").on(table.organizationId, table.createdAt),
	index("deployment_project_environment_idx").on(
		table.projectId,
		table.environmentId,
		table.createdAt,
	),
	index("deployment_status_idx").on(table.status),
	index("deployment_source_revision_idx").on(
		table.projectId,
		table.sourceRevision,
	),
	index("deployment_configuration_snapshot_idx").on(
		table.configurationSnapshotId,
	),
	uniqueIndex("deployment_id_organization_project_environment_unique").on(
		table.deploymentId,
		table.organizationId,
		table.projectId,
		table.environmentId,
	),
	uniqueIndex("deployment_id_organization_project_unique").on(
		table.deploymentId,
		table.organizationId,
		table.projectId,
	),
	foreignKey({
		name: "deployment_configuration_snapshot_ownership_fk",
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
		name: "deployment_project_organization_fk",
		columns: [table.projectId, table.organizationId],
		foreignColumns: [projects.projectId, projects.organizationId],
	}).onDelete("cascade"),
	foreignKey({
		name: "deployment_environment_project_organization_fk",
		columns: [table.environmentId, table.projectId, table.organizationId],
		foreignColumns: [
			environments.environmentId,
			environments.projectId,
			environments.organizationId,
		],
	}).onDelete("cascade"),
	foreignKey({
		name: "deployment_application_ownership_fk",
		columns: [
			table.applicationId,
			table.organizationId,
			table.projectId,
			table.environmentId,
		],
		foreignColumns: [
			applications.applicationId,
			applications.organizationId,
			applications.projectId,
			applications.environmentId,
		],
	}).onDelete("cascade"),
	foreignKey({
		name: "deployment_preview_ownership_fk",
		columns: [
			table.previewDeploymentId,
			table.organizationId,
			table.projectId,
			table.environmentId,
		],
		foreignColumns: [
			previewDeployments.previewDeploymentId,
			previewDeployments.organizationId,
			previewDeployments.projectId,
			previewDeployments.environmentId,
		],
	}).onDelete("cascade"),
]);

export const deploymentsRelations = relations(deployments, ({ one }) => ({
	configurationSnapshot: one(configurationSnapshots, {
		fields: [deployments.configurationSnapshotId],
		references: [configurationSnapshots.configurationSnapshotId],
	}),
	organization: one(organization, {
		fields: [deployments.organizationId],
		references: [organization.id],
	}),
	project: one(projects, {
		fields: [deployments.projectId],
		references: [projects.projectId],
	}),
	environment: one(environments, {
		fields: [deployments.environmentId],
		references: [environments.environmentId],
	}),
	application: one(applications, {
		fields: [deployments.applicationId],
		references: [applications.applicationId],
	}),
	compose: one(compose, {
		fields: [deployments.composeId],
		references: [compose.composeId],
	}),
	server: one(server, {
		fields: [deployments.serverId],
		references: [server.serverId],
		relationName: "deploymentServer",
	}),
	buildServer: one(server, {
		fields: [deployments.buildServerId],
		references: [server.serverId],
		relationName: "deploymentBuildServer",
	}),
	previewDeployment: one(previewDeployments, {
		fields: [deployments.previewDeploymentId],
		references: [previewDeployments.previewDeploymentId],
	}),
	schedule: one(schedules, {
		fields: [deployments.scheduleId],
		references: [schedules.scheduleId],
	}),
	backup: one(backups, {
		fields: [deployments.backupId],
		references: [backups.backupId],
	}),
	rollback: one(rollbacks, {
		fields: [deployments.deploymentId],
		references: [rollbacks.deploymentId],
	}),
	volumeBackup: one(volumeBackups, {
		fields: [deployments.volumeBackupId],
		references: [volumeBackups.volumeBackupId],
	}),
}));

const schema = createInsertSchema(deployments, {
	title: z.string().min(1),
	status: z.string().default("running"),
	logPath: z.string().min(1),
	applicationId: z.string(),
	composeId: z.string(),
	description: z.string().optional(),
	previewDeploymentId: z.string(),
	buildServerId: z.string(),
});
export const apiCreateDeployment = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		applicationId: true,
		description: true,
		previewDeploymentId: true,
	})
	.extend({
		applicationId: z.string().min(1),
	});

export const apiCreateDeploymentPreview = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		description: true,
		previewDeploymentId: true,
	})
	.extend({
		previewDeploymentId: z.string().min(1),
	});

export const apiCreateDeploymentCompose = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		composeId: true,
		description: true,
	})
	.extend({
		composeId: z.string().min(1),
	});

export const apiCreateDeploymentBackup = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		backupId: true,
		description: true,
	})
	.extend({
		backupId: z.string().min(1),
	});

export const apiCreateDeploymentServer = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		serverId: true,
		description: true,
	})
	.extend({
		serverId: z.string().min(1),
	});

export const apiCreateDeploymentSchedule = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		description: true,
	})
	.extend({
		scheduleId: z.string().min(1),
	});

export const apiCreateDeploymentVolumeBackup = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		description: true,
	})
	.extend({
		volumeBackupId: z.string().min(1),
	});

export const apiFindAllByApplication = z.object({
	applicationId: z.string().min(1),
});

export const apiFindAllByCompose = z.object({
	composeId: z.string().min(1),
});

export const apiFindAllByServer = z.object({
	serverId: z.string().min(1),
});

export const apiFindAllByType = z.object({
	id: z.string().min(1),
	type: z.enum([
		"application",
		"compose",
		"server",
		"schedule",
		"previewDeployment",
		"backup",
		"volumeBackup",
	]),
});
