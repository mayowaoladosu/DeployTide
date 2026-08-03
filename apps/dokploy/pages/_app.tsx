import "@/styles/globals.css";

import { BRAND } from "@dokploy/server/brand";
import type { NextPage } from "next";
import type { AppProps } from "next/app";
import { Manrope, Newsreader } from "next/font/google";
import Head from "next/head";
import { ThemeProvider } from "next-themes";
import NextTopLoader from "nextjs-toploader";
import type { ReactElement, ReactNode } from "react";
import { SearchCommand } from "@/components/dashboard/search-command";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, operatorApi } from "@/utils/api";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-dt-sans" });
const newsreader = Newsreader({
	subsets: ["latin"],
	variable: "--font-dt-display",
});

export type NextPageWithLayout<P = {}, IP = P> = NextPage<P, IP> & {
	getLayout?: (page: ReactElement) => ReactNode;
	theme?: string;
};

type AppPropsWithLayout = AppProps & {
	Component: NextPageWithLayout;
};

const MyApp = ({
	Component,
	pageProps: { ...pageProps },
}: AppPropsWithLayout) => {
	const getLayout = Component.getLayout ?? ((page) => page);

	return (
		<>
			<div className={`${manrope.variable} ${newsreader.variable}`}>
				<Head>
					<title>{BRAND.name}</title>
					<meta name="description" content={BRAND.description} />
				</Head>
				<TooltipProvider>
					<ThemeProvider
						attribute="class"
						defaultTheme="system"
						enableSystem
						disableTransitionOnChange
						forcedTheme={Component.theme}
					>
						<NextTopLoader color="hsl(var(--sidebar-ring))" />
						<Toaster richColors />
						<SearchCommand />
						{getLayout(<Component {...pageProps} />)}
					</ThemeProvider>
				</TooltipProvider>
			</div>
		</>
	);
};

export default api.withTRPC(operatorApi.withTRPC(MyApp));
