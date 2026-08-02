import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
	foreignKey,
	integer,
	json,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { backups } from "./backups";
import { environments } from "./environment";
import { mounts } from "./mount";
import { projects } from "./project";
import { server } from "./server";
import {
	applicationStatus,
	type EndpointSpecSwarm,
	EndpointSpecSwarmSchema,
	type HealthCheckSwarm,
	HealthCheckSwarmSchema,
	type LabelsSwarm,
	LabelsSwarmSchema,
	type NetworkSwarm,
	NetworkSwarmSchema,
	type PlacementSwarm,
	PlacementSwarmSchema,
	type RestartPolicySwarm,
	RestartPolicySwarmSchema,
	type ServiceModeSwarm,
	ServiceModeSwarmSchema,
	type UlimitsSwarm,
	UlimitsSwarmSchema,
	type UpdateConfigSwarm,
	UpdateConfigSwarmSchema,
} from "./shared";
import {
	APP_NAME_MESSAGE,
	APP_NAME_REGEX,
	DATABASE_PASSWORD_MESSAGE,
	DATABASE_PASSWORD_REGEX,
	encryptedText,
	generateAppName,
} from "./utils";

export const mariadb = pgTable("mariadb", {
	mariadbId: text("mariadbId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	appName: text("appName")
		.notNull()
		.$defaultFn(() => generateAppName("mariadb"))
		.unique(),
	description: text("description"),
	databaseName: text("databaseName").notNull(),
	databaseUser: text("databaseUser").notNull(),
	databasePassword: encryptedText("databasePassword").notNull(),
	databaseRootPassword: encryptedText("rootPassword").notNull(),
	dockerImage: text("dockerImage").notNull(),
	command: text("command"),
	args: text("args").array(),
	env: encryptedText("env"),
	// RESOURCES
	memoryReservation: text("memoryReservation"),
	memoryLimit: text("memoryLimit"),
	cpuReservation: text("cpuReservation"),
	cpuLimit: text("cpuLimit"),
	//
	externalPort: integer("externalPort"),
	applicationStatus: applicationStatus("applicationStatus")
		.notNull()
		.default("idle"),
	healthCheckSwarm: json("healthCheckSwarm").$type<HealthCheckSwarm>(),
	restartPolicySwarm: json("restartPolicySwarm").$type<RestartPolicySwarm>(),
	placementSwarm: json("placementSwarm").$type<PlacementSwarm>(),
	updateConfigSwarm: json("updateConfigSwarm").$type<UpdateConfigSwarm>(),
	rollbackConfigSwarm: json("rollbackConfigSwarm").$type<UpdateConfigSwarm>(),
	modeSwarm: json("modeSwarm").$type<ServiceModeSwarm>(),
	labelsSwarm: json("labelsSwarm").$type<LabelsSwarm>(),
	networkSwarm: json("networkSwarm").$type<NetworkSwarm[]>(),
	stopGracePeriodSwarm: bigint("stopGracePeriodSwarm", { mode: "number" }),
	endpointSpecSwarm: json("endpointSpecSwarm").$type<EndpointSpecSwarm>(),
	ulimitsSwarm: json("ulimitsSwarm").$type<UlimitsSwarm>(),
	replicas: integer("replicas").default(1).notNull(),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),

	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	projectId: text("projectId")
		.notNull()
		.references(() => projects.projectId, { onDelete: "cascade" }),
	environmentId: text("environmentId")
		.notNull()
		.references(() => environments.environmentId, { onDelete: "cascade" }),
	serverId: text("serverId").references(() => server.serverId, {
		onDelete: "cascade",
	}),
	networkIds: text("networkIds").array().default([]),
	detachDokployNetwork: boolean("detachDokployNetwork")
		.notNull()
		.default(false),
}, (table) => [
	uniqueIndex("mariadb_id_organization_project_environment_unique").on(
		table.mariadbId,
		table.organizationId,
		table.projectId,
		table.environmentId,
	),
	foreignKey({
		name: "mariadb_project_organization_fk",
		columns: [table.projectId, table.organizationId],
		foreignColumns: [projects.projectId, projects.organizationId],
	}).onDelete("cascade"),
	foreignKey({
		name: "mariadb_environment_project_organization_fk",
		columns: [table.environmentId, table.projectId, table.organizationId],
		foreignColumns: [environments.environmentId, environments.projectId, environments.organizationId],
	}).onDelete("cascade"),
]);

export const mariadbRelations = relations(mariadb, ({ one, many }) => ({
	organization: one(organization, {
		fields: [mariadb.organizationId],
		references: [organization.id],
	}),
	project: one(projects, {
		fields: [mariadb.projectId],
		references: [projects.projectId],
	}),
	environment: one(environments, {
		fields: [mariadb.environmentId],
		references: [environments.environmentId],
	}),
	backups: many(backups),
	mounts: many(mounts),
	server: one(server, {
		fields: [mariadb.serverId],
		references: [server.serverId],
	}),
}));

const createSchema = createInsertSchema(mariadb, {
	mariadbId: z.string(),
	name: z.string().min(1),
	appName: z
		.string()
		.min(1)
		.max(63)
		.regex(APP_NAME_REGEX, APP_NAME_MESSAGE)
		.optional(),
	createdAt: z.string(),
	databaseName: z.string().min(1),
	databaseUser: z.string().min(1),
	databasePassword: z.string().regex(DATABASE_PASSWORD_REGEX, {
		message: DATABASE_PASSWORD_MESSAGE,
	}),
	databaseRootPassword: z
		.string()
		.regex(DATABASE_PASSWORD_REGEX, {
			message: DATABASE_PASSWORD_MESSAGE,
		})
		.optional(),
	dockerImage: z.string().default("mariadb:6"),
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
	env: z.string().optional(),
	memoryReservation: z.string().optional(),
	memoryLimit: z.string().optional(),
	cpuReservation: z.string().optional(),
	cpuLimit: z.string().optional(),
	environmentId: z.string(),
	applicationStatus: z.enum(["idle", "running", "done", "error"]),
	externalPort: z.number(),
	description: z.string().optional(),
	serverId: z.string().optional(),
	healthCheckSwarm: HealthCheckSwarmSchema.nullable(),
	restartPolicySwarm: RestartPolicySwarmSchema.nullable(),
	placementSwarm: PlacementSwarmSchema.nullable(),
	updateConfigSwarm: UpdateConfigSwarmSchema.nullable(),
	rollbackConfigSwarm: UpdateConfigSwarmSchema.nullable(),
	modeSwarm: ServiceModeSwarmSchema.nullable(),
	labelsSwarm: LabelsSwarmSchema.nullable(),
	networkSwarm: NetworkSwarmSchema.nullable(),
	stopGracePeriodSwarm: z.number().nullable(),
	endpointSpecSwarm: EndpointSpecSwarmSchema.nullable(),
	ulimitsSwarm: UlimitsSwarmSchema.nullable(),
	networkIds: z.array(z.string()).optional(),
	detachDokployNetwork: z.boolean().optional(),
});

export const apiCreateMariaDB = createSchema.pick({
	name: true,
	appName: true,
	dockerImage: true,
	databaseRootPassword: true,
	environmentId: true,
	description: true,
	databaseName: true,
	databaseUser: true,
	databasePassword: true,
	serverId: true,
});

export const apiFindOneMariaDB = z.object({
	mariadbId: z.string().min(1),
});

export const apiChangeMariaDBStatus = createSchema
	.pick({
		mariadbId: true,
		applicationStatus: true,
	})
	.required();

export const apiSaveEnvironmentVariablesMariaDB = createSchema
	.pick({
		mariadbId: true,
		env: true,
	})
	.required();

export const apiSaveExternalPortMariaDB = createSchema
	.pick({
		mariadbId: true,
		externalPort: true,
	})
	.required();

export const apiDeployMariaDB = createSchema
	.pick({
		mariadbId: true,
	})
	.required();

export const apiResetMariadb = createSchema
	.pick({
		mariadbId: true,
		appName: true,
	})
	.required();

export const apiUpdateMariaDB = createSchema
	.partial()
	.extend({
		mariadbId: z.string().min(1),
		dockerImage: z.string().optional(),
	})
	.omit({ serverId: true });

export const apiRebuildMariadb = createSchema
	.pick({
		mariadbId: true,
	})
	.required();
