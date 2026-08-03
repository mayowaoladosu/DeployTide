import type { GetServerSidePropsContext } from "next";
import { redirectLegacyWorkspaceSection } from "@/server/product-pages";
export default function LegacyInvoicesRoute() { return null; }
export const getServerSideProps = (ctx: GetServerSidePropsContext) => redirectLegacyWorkspaceSection(ctx, "invoices");
