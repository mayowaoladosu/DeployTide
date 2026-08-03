import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { ProjectSurface } from "@/components/project-overview/project-surface";
import type { ProjectPageProps } from "@/server/product-pages";
import { requireActiveProjectPage } from "@/server/product-pages";

const ProjectDeploymentsPage = ({ projectSlug }: ProjectPageProps) => <ProjectSurface projectSlug={projectSlug} kind="deployments" />;
ProjectDeploymentsPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default ProjectDeploymentsPage;
export const getServerSideProps = (ctx: GetServerSidePropsContext) => requireActiveProjectPage(ctx);
