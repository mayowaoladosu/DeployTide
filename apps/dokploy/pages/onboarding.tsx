import { db } from "@dokploy/server/db";
import { organization } from "@dokploy/server/db/schema";
import { validateRequest } from "@dokploy/server/lib/auth";
import { eq } from "drizzle-orm";
import type { GetServerSidePropsContext } from "next";
import { WorkspaceOnboarding } from "@/components/workspace-overview/workspace-onboarding";

export default WorkspaceOnboarding;

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { user, session } = await validateRequest(ctx.req);
	if (!user) return { redirect: { permanent: false, destination: "/" } };
	if (session?.activeOrganizationId) {
		const workspace = await db.query.organization.findFirst({
			where: eq(organization.id, session.activeOrganizationId),
			columns: { slug: true },
		});
		if (workspace?.slug) {
			return { redirect: { permanent: false, destination: `/${workspace.slug}` } };
		}
	}
	return { props: {} };
}
