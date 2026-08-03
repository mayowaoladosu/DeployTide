import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { DeploymentDetail } from "@/components/project-overview/deployment-detail";
import type { ProjectPageProps } from "@/server/product-pages";
import { requireActiveProjectPage } from "@/server/product-pages";

interface Props extends ProjectPageProps { deploymentId: string }
const DeploymentPage = ({ projectSlug, deploymentId }: Props) => <DeploymentDetail projectSlug={projectSlug} deploymentId={deploymentId} />;
DeploymentPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default DeploymentPage;
export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const result = await requireActiveProjectPage(ctx);
	if (!("props" in result)) return result;
	const deploymentId = Array.isArray(ctx.params?.deploymentId) ? ctx.params?.deploymentId[0] : ctx.params?.deploymentId;
	if (!deploymentId) return { notFound: true };
	return { props: { ...result.props, deploymentId } };
}
