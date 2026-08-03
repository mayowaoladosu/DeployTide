import type { GetServerSidePropsContext } from "next";
import { InfrastructureConsole } from "@/components/admin/infrastructure-console";
import type { OperatorPageProps } from "@/server/operator-pages";
import { requireSuperadminPage } from "@/server/operator-pages";

export default function InfrastructurePage(props: OperatorPageProps) {
	return <InfrastructureConsole section="overview" {...props} />;
}

InfrastructurePage.getLayout = (page: React.ReactElement) => page;

export const getServerSideProps = (ctx: GetServerSidePropsContext) =>
	requireSuperadminPage(ctx);
