import type { GetServerSidePropsContext } from "next";
import { redirectLegacyWorkspaceSection } from "@/server/product-pages";
export default function LegacyConnectionsRoute() { return null; }
export const getServerSideProps = (ctx: GetServerSidePropsContext) => redirectLegacyWorkspaceSection(ctx, "integrations");
