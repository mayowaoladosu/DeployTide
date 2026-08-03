import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { WorkspaceOverview } from "@/components/workspace-overview/workspace-overview";
import { requireActiveWorkspacePage } from "@/server/product-pages";

const WorkspacePage = () => <WorkspaceOverview />;
WorkspacePage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default WorkspacePage;
export const getServerSideProps = (ctx: GetServerSidePropsContext) => requireActiveWorkspacePage(ctx);
