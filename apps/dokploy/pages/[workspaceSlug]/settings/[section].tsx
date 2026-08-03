import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { WorkspaceSettings, type WorkspaceSettingsSection } from "@/components/workspace-overview/workspace-settings";
import { requireActiveWorkspacePage } from "@/server/product-pages";

const allowed = new Set(["integrations", "notifications", "billing", "invoices"]);
const WorkspaceSettingsPage = () => {
	const router = useRouter();
	const value = typeof router.query.section === "string" ? router.query.section : "integrations";
	return <WorkspaceSettings section={(allowed.has(value) ? value : "integrations") as WorkspaceSettingsSection} />;
};
WorkspaceSettingsPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default WorkspaceSettingsPage;
export const getServerSideProps = (ctx: GetServerSidePropsContext) => requireActiveWorkspacePage(ctx);
