import type { GetServerSidePropsContext } from "next";
import { redirectLegacyProjectPage } from "@/server/product-pages";

export default function LegacyApplicationRoute() {
	return null;
}

export const getServerSideProps = (ctx: GetServerSidePropsContext) =>
	redirectLegacyProjectPage(ctx);
