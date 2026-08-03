import type { GetServerSidePropsContext } from "next";
import { redirectLegacyProjectPage } from "@/server/product-pages";

export default function LegacyEnvironmentRoute() {
	return null;
}

export const getServerSideProps = (ctx: GetServerSidePropsContext) =>
	redirectLegacyProjectPage(ctx);
