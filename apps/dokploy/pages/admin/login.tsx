import type { GetServerSidePropsContext } from "next";
import { OperatorLogin } from "@/components/admin/operator-login";
import type { OperatorPageProps } from "@/server/operator-pages";
import { requireOperatorLoginPage } from "@/server/operator-pages";

export default function OperatorLoginPage(props: OperatorPageProps) {
	return <OperatorLogin {...props} />;
}

OperatorLoginPage.getLayout = (page: React.ReactElement) => page;

export const getServerSideProps = (ctx: GetServerSidePropsContext) =>
	requireOperatorLoginPage(ctx);
