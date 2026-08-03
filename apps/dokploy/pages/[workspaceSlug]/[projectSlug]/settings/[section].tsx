import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { ProjectSurface } from "@/components/project-overview/project-surface";
import type { ProjectPageProps } from "@/server/product-pages";
import { requireActiveProjectPage } from "@/server/product-pages";

const allowed = new Set(["git", "builds", "environments", "variables", "protection", "advanced"]);
const ProjectSettingsSectionPage = ({ projectSlug }: ProjectPageProps) => {
	const router = useRouter();
	const value = typeof router.query.section === "string" ? router.query.section : "general";
	return <ProjectSurface projectSlug={projectSlug} kind="settings" settingsSection={allowed.has(value) ? value : "general"} />;
};
ProjectSettingsSectionPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default ProjectSettingsSectionPage;
export const getServerSideProps = (ctx: GetServerSidePropsContext) => requireActiveProjectPage(ctx);
