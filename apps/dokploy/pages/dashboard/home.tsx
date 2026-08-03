import type { GetServerSidePropsContext } from "next";
import { redirectLegacyDashboard } from "@/server/product-pages";

export default function LegacyHomeRoute() {
	return null;
}

export const getServerSideProps = (ctx: GetServerSidePropsContext) =>
	redirectLegacyDashboard(ctx);
