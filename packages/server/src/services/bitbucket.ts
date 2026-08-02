import { db } from "@dokploy/server/db";
import {
	type apiCreateBitbucket,
	type apiUpdateBitbucket,
	bitbucket,
	gitProvider,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

export type Bitbucket = typeof bitbucket.$inferSelect;

export const createBitbucket = async (
	input: z.infer<typeof apiCreateBitbucket>,
	organizationId: string,
	userId: string,
) => {
	return await db.transaction(async (tx) => {
		const newGitProvider = await tx
			.insert(gitProvider)
			.values({
				providerType: "bitbucket",
				organizationId: organizationId,
				name: input.name,
				userId: userId,
			})
			.returning()
			.then((response) => response[0]);

		if (!newGitProvider) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the Bitbucket provider",
			});
		}

		const newBitbucket = await tx
			.insert(bitbucket)
			.values({
				...input,
				gitProviderId: newGitProvider?.gitProviderId,
			})
			.returning()
			.then((response) => response[0]);
		if (!newBitbucket) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the Bitbucket provider",
			});
		}
		return newBitbucket;
	});
};

export const findBitbucketById = async (bitbucketId: string) => {
	const bitbucketProviderResult = await db.query.bitbucket.findFirst({
		where: eq(bitbucket.bitbucketId, bitbucketId),
		with: {
			gitProvider: true,
		},
	});

	if (!bitbucketProviderResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Bitbucket Provider not found",
		});
	}

	return bitbucketProviderResult;
};

export const updateBitbucket = async (
	bitbucketId: string,
	organizationId: string,
	input: z.infer<typeof apiUpdateBitbucket>,
) => {
	return await db.transaction(async (tx) => {
		// First get the current bitbucket provider to get gitProviderId
		const currentProvider = await tx.query.bitbucket.findFirst({
			where: eq(bitbucket.bitbucketId, bitbucketId),
			with: { gitProvider: true },
		});

		if (
			!currentProvider ||
			currentProvider.gitProvider.organizationId !== organizationId
		) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Bitbucket provider not found",
			});
		}

		const result = await tx
			.update(bitbucket)
			.set({
				bitbucketUsername: input.bitbucketUsername,
				bitbucketEmail: input.bitbucketEmail,
				bitbucketWorkspaceName: input.bitbucketWorkspaceName,
				...(input.appPassword ? { appPassword: input.appPassword } : {}),
				...(input.apiToken ? { apiToken: input.apiToken } : {}),
			})
			.where(eq(bitbucket.bitbucketId, bitbucketId))
			.returning();

		if (input.name) {
			await tx
				.update(gitProvider)
				.set({
					name: input.name,
				})
				.where(
					and(
						eq(gitProvider.gitProviderId, currentProvider.gitProviderId),
						eq(gitProvider.organizationId, organizationId),
					),
				)
				.returning();
		}

		if (!result[0]) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Bitbucket provider changed while it was being updated",
			});
		}
		return result[0];
	});
};
