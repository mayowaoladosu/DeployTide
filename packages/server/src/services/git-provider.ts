import { db } from "@dokploy/server/db";
import {
	bitbucket,
	gitea,
	github,
	gitlab,
	gitProvider,
	member,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

export type GitProvider = typeof gitProvider.$inferSelect;

export const removeGitProvider = async (gitProviderId: string) => {
	const result = await db
		.delete(gitProvider)
		.where(eq(gitProvider.gitProviderId, gitProviderId))
		.returning();

	return result[0];
};

export const findGitProviderById = async (gitProviderId: string) => {
	const result = await db.query.gitProvider.findFirst({
		where: eq(gitProvider.gitProviderId, gitProviderId),
	});

	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Git Provider not found",
		});
	}
	return result;
};

export const updateGitProvider = async (
	gitProviderId: string,
	organizationId: string,
	input: Partial<GitProvider>,
) => {
	const { organizationId: _ignoredOrganizationId, ...safeInput } = input;
	return await db
		.update(gitProvider)
		.set({
			...safeInput,
		})
		.where(
			and(
				eq(gitProvider.gitProviderId, gitProviderId),
				eq(gitProvider.organizationId, organizationId),
			),
		)
		.returning()
		.then((response) => response[0] ?? null);
};

// Returns true if the user can edit the git source configuration of an existing
// deploy that is connected to the given provider.
// Owner/admin: always yes.
// Member: only if they own the provider or it's shared with the org.
// Being in accessedGitProviders only grants permission to connect NEW deploys,
// not to modify the git config of an existing deploy owned by someone else.
export const canEditDeployGitSource = async (
	gitProviderId: string,
	session: { userId: string; activeOrganizationId: string },
): Promise<boolean> => {
	const { userId, activeOrganizationId } = session;

	const memberRecord = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, activeOrganizationId),
		),
		columns: { role: true },
	});

	if (memberRecord?.role === "owner") return true;

	const provider = await db.query.gitProvider.findFirst({
		where: eq(gitProvider.gitProviderId, gitProviderId),
		columns: { userId: true, sharedWithOrganization: true },
	});

	if (!provider) return false;

	return provider.userId === userId || provider.sharedWithOrganization;
};

export const getAccessibleGitProviderIds = async (session: {
	userId: string;
	activeOrganizationId: string;
}): Promise<Set<string>> => {
	const { userId, activeOrganizationId } = session;

	const allOrgProviders = await db.query.gitProvider.findMany({
		where: eq(gitProvider.organizationId, activeOrganizationId),
		columns: {
			gitProviderId: true,
			userId: true,
			sharedWithOrganization: true,
		},
	});

	const memberRecord = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, activeOrganizationId),
		),
		columns: { accessedGitProviders: true, role: true },
	});

	if (memberRecord?.role === "owner" || memberRecord?.role === "admin") {
		return new Set(allOrgProviders.map((p) => p.gitProviderId));
	}

	const assignedSet = new Set(memberRecord?.accessedGitProviders ?? []);

	const result = new Set<string>();
	for (const p of allOrgProviders) {
		if (
			p.userId === userId ||
			p.sharedWithOrganization ||
			assignedSet.has(p.gitProviderId)
		) {
			result.add(p.gitProviderId);
		}
	}
	return result;
};

/**
 * Authorizes read access to a specific git provider for the current session.
 * Throws if the provider belongs to a different organization (cross-org IDOR)
 * or if the caller is not entitled to it within the active organization.
 * Must be called before returning any git-provider record that carries secrets
 * (OAuth tokens, app private keys, webhook secrets).
 */
export const assertGitProviderAccess = async (
	session: { userId: string; activeOrganizationId: string },
	provider: { gitProviderId: string; organizationId: string },
) => {
	if (provider.organizationId !== session.activeOrganizationId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Git provider not found",
		});
	}

	const accessibleIds = await getAccessibleGitProviderIds(session);
	if (!accessibleIds.has(provider.gitProviderId)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "You don't have access to this git provider",
		});
	}
};

export const assertGitSourceAttachmentAccess = async (
	session: { userId: string; activeOrganizationId: string },
	references: {
		githubId?: string | null;
		gitlabId?: string | null;
		bitbucketId?: string | null;
		giteaId?: string | null;
	},
) => {
	const lookups = [
		references.githubId
			? db.query.github.findFirst({
					where: eq(github.githubId, references.githubId),
					with: { gitProvider: true },
				})
			: null,
		references.gitlabId
			? db.query.gitlab.findFirst({
					where: eq(gitlab.gitlabId, references.gitlabId),
					with: { gitProvider: true },
				})
			: null,
		references.bitbucketId
			? db.query.bitbucket.findFirst({
					where: eq(bitbucket.bitbucketId, references.bitbucketId),
					with: { gitProvider: true },
				})
			: null,
		references.giteaId
			? db.query.gitea.findFirst({
					where: eq(gitea.giteaId, references.giteaId),
					with: { gitProvider: true },
				})
			: null,
	].filter((lookup): lookup is NonNullable<typeof lookup> => lookup !== null);

	for (const provider of await Promise.all(lookups)) {
		if (!provider) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Git provider not found" });
		}
		await assertGitProviderAccess(session, provider.gitProvider);
	}
};
