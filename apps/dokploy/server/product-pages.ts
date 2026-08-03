import { db } from "@dokploy/server/db";
import { organization, projects } from "@dokploy/server/db/schema";
import { validateRequest } from "@dokploy/server/lib/auth";
import { findMemberByUserId } from "@dokploy/server/services/permission";
import { and, eq, isNull } from "drizzle-orm";
import type {
	GetServerSidePropsContext,
	GetServerSidePropsResult,
} from "next";

export interface WorkspacePageProps {
	workspaceSlug: string;
}

export interface ProjectPageProps extends WorkspacePageProps {
	projectSlug: string;
}

const stringParam = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

const authenticate = async (ctx: GetServerSidePropsContext) => {
	const { user, session } = await validateRequest(ctx.req);
	if (!user) return { kind: "unauthenticated" as const };
	if (!session?.activeOrganizationId) return { kind: "onboarding" as const };
	const workspace = await db.query.organization.findFirst({
		where: and(
			eq(organization.id, session.activeOrganizationId),
			isNull(organization.deletedAt),
		),
		columns: { id: true, slug: true },
	});
	const workspaceSlug = workspace?.slug;
	if (!workspace || !workspaceSlug) return { kind: "onboarding" as const };
	return {
		kind: "ready" as const,
		user,
		session,
		workspace: { ...workspace, slug: workspaceSlug },
	};
};

const authRedirect = (kind: "unauthenticated" | "onboarding") => ({
	redirect: {
		permanent: false,
		destination: kind === "onboarding" ? "/onboarding" : "/",
	},
}) as const;

export const requireActiveWorkspacePage = async (
	ctx: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<WorkspacePageProps>> => {
	const auth = await authenticate(ctx);
	if (auth.kind !== "ready") return authRedirect(auth.kind);
	const requested = stringParam(ctx.params?.workspaceSlug);
	if (requested && requested !== auth.workspace.slug) {
		return {
			redirect: {
				permanent: false,
				destination: `/${auth.workspace.slug}`,
			},
		};
	}
	return { props: { workspaceSlug: auth.workspace.slug } };
};

export const requireActiveProjectPage = async (
	ctx: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<ProjectPageProps>> => {
	const auth = await authenticate(ctx);
	if (auth.kind !== "ready") return authRedirect(auth.kind);
	const requestedWorkspace = stringParam(ctx.params?.workspaceSlug);
	if (requestedWorkspace !== auth.workspace.slug) {
		return {
			redirect: {
				permanent: false,
				destination: `/${auth.workspace.slug}`,
			},
		};
	}
	const projectSlug = stringParam(ctx.params?.projectSlug);
	if (!projectSlug) return { notFound: true };
	const project = await db.query.projects.findFirst({
		where: and(
			eq(projects.organizationId, auth.workspace.id),
			eq(projects.slug, projectSlug),
			isNull(projects.deletedAt),
		),
		columns: { projectId: true, slug: true },
	});
	if (!project) return { notFound: true };
	const member = await findMemberByUserId(auth.user.id, auth.workspace.id);
	if (
		member.role !== "owner" &&
		member.role !== "admin" &&
		!member.accessedProjects.includes(project.projectId)
	) {
		return { notFound: true };
	}
	return {
		props: {
			workspaceSlug: auth.workspace.slug,
			projectSlug: project.slug,
		},
	};
};

export const redirectLegacyDashboard = async (
	ctx: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<Record<string, never>>> => {
	const auth = await authenticate(ctx);
	if (auth.kind !== "ready") return authRedirect(auth.kind);
	return {
		redirect: {
			permanent: false,
			destination: `/${auth.workspace.slug}`,
		},
	};
};

export const redirectLegacyProjectPage = async (
	ctx: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<Record<string, never>>> => {
	const auth = await authenticate(ctx);
	if (auth.kind !== "ready") return authRedirect(auth.kind);
	const projectId = stringParam(ctx.params?.projectId);
	if (!projectId) return { notFound: true };
	const project = await db.query.projects.findFirst({
		where: and(
			eq(projects.projectId, projectId),
			eq(projects.organizationId, auth.workspace.id),
			isNull(projects.deletedAt),
		),
		columns: { projectId: true, slug: true },
	});
	if (!project) return { notFound: true };
	const member = await findMemberByUserId(auth.user.id, auth.workspace.id);
	if (
		member.role !== "owner" &&
		member.role !== "admin" &&
		!member.accessedProjects.includes(project.projectId)
	) {
		return { notFound: true };
	}
	return {
		redirect: {
			permanent: false,
			destination: `/${auth.workspace.slug}/${project.slug}`,
		},
	};
};

export const redirectLegacyWorkspaceSection = async (
	ctx: GetServerSidePropsContext,
	section: "billing" | "invoices" | "integrations" | "notifications",
): Promise<GetServerSidePropsResult<Record<string, never>>> => {
	const auth = await authenticate(ctx);
	if (auth.kind !== "ready") return authRedirect(auth.kind);
	return {
		redirect: {
			permanent: false,
			destination: `/${auth.workspace.slug}/settings/${section}`,
		},
	};
};
