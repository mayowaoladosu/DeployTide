import {
	createSshKey,
	findSSHKeyById,
	generateSSHKey,
	recordOperatorAudit,
	removeSSHKeyById,
	updateSSHKeyById,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { createTRPCRouter, operatorProcedure } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateSshKey,
	apiFindOneSshKey,
	apiGenerateSSHKey,
	apiRemoveSshKey,
	apiUpdateSshKey,
	sshKeys,
} from "@/server/db/schema";

const protectedProcedure = operatorProcedure;
const withPermission = (_resource: string, _action: string) =>
	operatorProcedure;

const auditOperatorSshMutation = (
	ctx: {
		user: { id: string; email: string };
		req: { headers: Record<string, string | string[] | undefined> };
	},
	action: string,
	resourceId?: string,
) =>
	recordOperatorAudit({
		actorUserId: ctx.user.id,
		actorEmail: ctx.user.email,
		action,
		resourceType: "legacySshAdapter",
		resourceId,
		requestId:
			typeof ctx.req.headers["x-request-id"] === "string"
				? ctx.req.headers["x-request-id"]
				: null,
	});

export const sshRouter = createTRPCRouter({
	create: withPermission("sshKeys", "create")
		.input(apiCreateSshKey)
		.mutation(async ({ input, ctx }) => {
			try {
				await createSshKey({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "create",
					resourceType: "sshKey",
					resourceName: input.name,
				});
				await auditOperatorSshMutation(ctx, "create");
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the SSH key",
					cause: error,
				});
			}
		}),
	remove: withPermission("sshKeys", "delete")
		.input(apiRemoveSshKey)
		.mutation(async ({ input, ctx }) => {
			try {
				const sshKey = await findSSHKeyById(input.sshKeyId);
				if (sshKey.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to delete this SSH key",
					});
				}

				await audit(ctx, {
					action: "delete",
					resourceType: "sshKey",
					resourceId: sshKey.sshKeyId,
					resourceName: sshKey.name,
				});
				await removeSSHKeyById(input.sshKeyId);
				await auditOperatorSshMutation(ctx, "delete", sshKey.sshKeyId);
				return { sshKeyId: sshKey.sshKeyId, removed: true };
			} catch (error) {
				throw error;
			}
		}),
	one: withPermission("sshKeys", "read")
		.input(apiFindOneSshKey)
		.query(async ({ input, ctx }) => {
			const sshKey = await findSSHKeyById(input.sshKeyId);

			if (sshKey.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to access this SSH key",
				});
			}
			return {
				sshKeyId: sshKey.sshKeyId,
				name: sshKey.name,
				description: sshKey.description,
				publicKey: sshKey.publicKey,
				createdAt: sshKey.createdAt,
				lastUsedAt: sshKey.lastUsedAt,
			};
		}),
	all: withPermission("sshKeys", "read").query(async ({ ctx }) => {
		return await db.query.sshKeys.findMany({
			columns: {
				sshKeyId: true,
				name: true,
				description: true,
				publicKey: true,
				createdAt: true,
				lastUsedAt: true,
			},
			where: eq(sshKeys.organizationId, ctx.session.activeOrganizationId),
			orderBy: desc(sshKeys.createdAt),
		});
	}),
	allForApps: protectedProcedure.query(async ({ ctx }) => {
		return await db.query.sshKeys.findMany({
			columns: {
				sshKeyId: true,
				name: true,
			},
			where: eq(sshKeys.organizationId, ctx.session.activeOrganizationId),
			orderBy: desc(sshKeys.createdAt),
		});
	}),
	generate: withPermission("sshKeys", "read")
		.input(apiGenerateSSHKey)
		.mutation(async ({ input, ctx }) => {
			const generated = await generateSSHKey(input.type);
			await auditOperatorSshMutation(ctx, "generate");
			return { publicKey: generated.publicKey, privateKey: "" };
		}),
	update: withPermission("sshKeys", "create")
		.input(apiUpdateSshKey)
		.mutation(async ({ input, ctx }) => {
			try {
				const sshKey = await findSSHKeyById(input.sshKeyId);
				if (sshKey.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to update this SSH key",
					});
				}
				const result = await updateSSHKeyById(input);
				if (!result) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "SSH key not found",
					});
				}
				await audit(ctx, {
					action: "update",
					resourceType: "sshKey",
					resourceId: sshKey.sshKeyId,
					resourceName: sshKey.name,
				});
				await auditOperatorSshMutation(ctx, "update", sshKey.sshKeyId);
				return {
					sshKeyId: result.sshKeyId,
					name: result.name,
					description: result.description,
					publicKey: result.publicKey,
					createdAt: result.createdAt,
					lastUsedAt: result.lastUsedAt,
				};
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating this SSH key",
					cause: error,
				});
			}
		}),
});
