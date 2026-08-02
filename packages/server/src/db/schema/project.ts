import { relations } from "drizzle-orm";
import {
	type AnyPgColumn,
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
import { environments } from "./environment";
import { projectTags } from "./tag";
import { encryptedText } from "./utils";

export const projects = pgTable("project", {
	projectId: text("projectId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	description: text("description"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),

	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	primaryApplicationId: text("primaryApplicationId").references(
		(): AnyPgColumn => applications.applicationId,
		{ onDelete: "set null" },
	),
	env: encryptedText("env").notNull().default(""),
	deletedAt: timestamp("deletedAt", { withTimezone: true }),
}, (table) => [
	uniqueIndex("project_id_organization_unique").on(
		table.projectId,
		table.organizationId,
	),
]);

export const projectRelations = relations(projects, ({ many, one }) => ({
	environments: many(environments),
	projectTags: many(projectTags),
	organization: one(organization, {
		fields: [projects.organizationId],
		references: [organization.id],
	}),
	primaryApplication: one(applications, {
		fields: [projects.primaryApplicationId],
		references: [applications.applicationId],
	}),
}));

const createSchema = createInsertSchema(projects, {
	projectId: z.string().min(1),
	name: z.string().min(1),
	description: z.string().optional(),
	env: z.string().optional(),
});

export const apiCreateProject = createSchema.pick({
	name: true,
	description: true,
	env: true,
});

export const apiFindOneProject = z.object({
	projectId: z.string().min(1),
});
export const apiRemoveProject = createSchema
	.pick({
		projectId: true,
	})
	.required();

// export const apiUpdateProject = createSchema
// 	.pick({
// 		name: true,
// 		description: true,
// 		projectId: true,
// 		env: true,
// 	})
// 	.required();

export const apiUpdateProject = createSchema
	.pick({
		name: true,
		description: true,
		env: true,
	})
	.partial()
	.extend({
		projectId: z.string().min(1),
	});
