import { validateRequest } from "@dokploy/server/lib/auth";
import type { GetServerSidePropsContext, GetServerSidePropsResult } from "next";
import { isConfiguredSuperadmin, verifyOperatorSession } from "./operator-auth";

export interface OperatorPageProps {
	operatorEmail: string;
}

const authenticateOperator = async (ctx: GetServerSidePropsContext) => {
	const { user } = await validateRequest(ctx.req);
	if (!user) return { kind: "unauthenticated" as const };
	if (!isConfiguredSuperadmin(user.email)) {
		return { kind: "not-superadmin" as const };
	}
	return {
		kind: verifyOperatorSession({
			req: ctx.req,
			userId: user.id,
			email: user.email,
		})
			? ("ready" as const)
			: ("reauthenticate" as const),
		user,
	};
};

export const requireSuperadminPage = async (
	ctx: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<OperatorPageProps>> => {
	const auth = await authenticateOperator(ctx);
	if (auth.kind === "unauthenticated") {
		return { redirect: { destination: "/", permanent: false } };
	}
	if (auth.kind === "not-superadmin") return { notFound: true };
	if (auth.kind === "reauthenticate") {
		return {
			redirect: {
				destination: `/admin/login?returnTo=${encodeURIComponent(ctx.resolvedUrl)}`,
				permanent: false,
			},
		};
	}
	return { props: { operatorEmail: auth.user.email } };
};

export const requireOperatorLoginPage = async (
	ctx: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<OperatorPageProps>> => {
	const auth = await authenticateOperator(ctx);
	if (auth.kind === "unauthenticated") {
		return { redirect: { destination: "/", permanent: false } };
	}
	if (auth.kind === "not-superadmin") return { notFound: true };
	if (auth.kind === "ready") {
		return {
			redirect: { destination: "/admin/infrastructure", permanent: false },
		};
	}
	return { props: { operatorEmail: auth.user.email } };
};
