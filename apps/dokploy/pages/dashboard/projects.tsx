import type { GetServerSidePropsContext } from "next";
import { redirectLegacyDashboard } from "@/server/product-pages";

export default function LegacyProjectsRoute() {
	return null;
}

export const getServerSideProps = (ctx: GetServerSidePropsContext) =>
	redirectLegacyDashboard(ctx);
