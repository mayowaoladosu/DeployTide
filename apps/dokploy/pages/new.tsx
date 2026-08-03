import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { ImportProject } from "@/components/project-overview/import-project";
import { requireActiveWorkspacePage } from "@/server/product-pages";

const NewProjectPage = () => <ImportProject />;
NewProjectPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default NewProjectPage;
export const getServerSideProps = (ctx: GetServerSidePropsContext) => requireActiveWorkspacePage(ctx);
