import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { ProjectSurface } from "@/components/project-overview/project-surface";
import type { ProjectPageProps } from "@/server/product-pages";
import { requireActiveProjectPage } from "@/server/product-pages";

const ProjectDomainsPage = ({ projectSlug }: ProjectPageProps) => <ProjectSurface projectSlug={projectSlug} kind="domains" />;
ProjectDomainsPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default ProjectDomainsPage;
export const getServerSideProps = (ctx: GetServerSidePropsContext) => requireActiveProjectPage(ctx);
