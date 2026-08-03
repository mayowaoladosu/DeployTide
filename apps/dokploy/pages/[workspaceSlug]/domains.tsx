import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { WorkspaceSurface } from "@/components/workspace-overview/workspace-surface";
import { requireActiveWorkspacePage } from "@/server/product-pages";

const DomainsPage = () => <WorkspaceSurface kind="domains" />;
DomainsPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default DomainsPage;
export const getServerSideProps = (ctx: GetServerSidePropsContext) => requireActiveWorkspacePage(ctx);
