import { db } from "@dokploy/server/db";
import {
	type apiCreateGitlab,
	gitlab,
	gitProvider,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";

export type Gitlab = typeof gitlab.$inferSelect;

export const createGitlab = async (
	input: z.infer<typeof apiCreateGitlab>,
	organizationId: string,
	userId: string,
) => {
	return await db.transaction(async (tx) => {
		const newGitProvider = await tx
			.insert(gitProvider)
			.values({
				providerType: "gitlab",
				organizationId: organizationId,
				name: input.name,
				userId: userId,
			})
			.returning()
			.then((response) => response[0]);

		if (!newGitProvider) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the Git provider",
			});
		}

		const newGitlab = await tx
			.insert(gitlab)
			.values({
				...input,
				gitProviderId: newGitProvider?.gitProviderId,
			})
			.returning()
			.then((response) => response[0]);
		if (!newGitlab) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the Gitlab provider",
			});
		}
		return newGitlab;
	});
};

export const findGitlabById = async (gitlabId: string) => {
	const gitlabProviderResult = await db.query.gitlab.findFirst({
		where: eq(gitlab.gitlabId, gitlabId),
		with: {
			gitProvider: true,
		},
	});

	if (!gitlabProviderResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Gitlab Provider not found",
		});
	}

	return gitlabProviderResult;
};

export const updateGitlab = async (
	gitlabId: string,
	organizationId: string,
	input: Partial<Gitlab>,
	providerData?: { name: string },
) => {
	return db.transaction(async (transaction) => {
		const current = await transaction.query.gitlab.findFirst({
			where: eq(gitlab.gitlabId, gitlabId),
			with: { gitProvider: true },
		});
		if (!current || current.gitProvider.organizationId !== organizationId) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Gitlab Provider not found" });
		}
		if (providerData) {
			await transaction
				.update(gitProvider)
				.set(providerData)
				.where(eq(gitProvider.gitProviderId, current.gitProviderId));
		}
		const [updated] = await transaction
			.update(gitlab)
			.set(input)
			.where(eq(gitlab.gitlabId, gitlabId))
			.returning();
		return updated;
	});
};
