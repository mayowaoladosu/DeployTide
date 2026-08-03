import {
	Activity,
	BarChart3,
	BookOpen,
	Boxes,
	ChevronDown,
	FolderGit2,
	Gauge,
	GitPullRequest,
	Globe2,
	LayoutDashboard,
	ListFilter,
	Plus,
	Search,
	Settings2,
	TerminalSquare,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactNode } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { UserNav } from "../layouts/user-nav";
import { WorkspaceSwitcher } from "./workspace-switcher";

interface NavigationItem {
	label: string;
	href: string;
	icon: typeof LayoutDashboard;
}

const isCurrent = (pathname: string, href: string) =>
	pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));

const NavLink = ({ item, pathname }: { item: NavigationItem; pathname: string }) => {
	const active = isCurrent(pathname, item.href);
	return (
		<Link
			href={item.href}
			aria-current={active ? "page" : undefined}
			className={cn(
				"dt-focus group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all",
				active
					? "bg-[var(--dt-ink)] text-white shadow-[0_8px_24px_rgba(17,24,39,0.14)] dark:bg-white dark:text-black"
					: "text-muted-foreground hover:bg-black/[0.045] hover:text-foreground dark:hover:bg-white/[0.06]",
			)}
		>
			<item.icon
				className={cn(
					"size-4 shrink-0 transition-transform group-hover:scale-105",
					active && "text-[var(--dt-signal)] dark:text-[var(--dt-signal-deep)]",
				)}
			/>
			<span>{item.label}</span>
		</Link>
	);
};

export const ProductNavigation = ({ children }: { children: ReactNode }) => {
	const router = useRouter();
	const pathname = router.asPath.split("?")[0] || "";
	const { data: context, isPending } = api.product.context.useQuery();
	const workspaceSlug = context?.workspace.slug;
	const routeProjectSlug =
		typeof router.query.projectSlug === "string"
			? router.query.projectSlug
			: undefined;
	const project = context?.projects.find(
		(candidate) => candidate.slug === routeProjectSlug,
	);

	const workspaceItems: NavigationItem[] = workspaceSlug
		? [
				{ label: "Overview", href: `/${workspaceSlug}`, icon: LayoutDashboard },
				{
					label: "Deployments",
					href: `/${workspaceSlug}/deployments`,
					icon: GitPullRequest,
				},
				{ label: "Activity", href: `/${workspaceSlug}/activity`, icon: Activity },
				{ label: "Domains", href: `/${workspaceSlug}/domains`, icon: Globe2 },
				{ label: "Usage", href: `/${workspaceSlug}/usage`, icon: Gauge },
			]
		: [];
	const projectItems: NavigationItem[] =
		workspaceSlug && project
			? [
					{
						label: "Overview",
						href: `/${workspaceSlug}/${project.slug}`,
						icon: LayoutDashboard,
					},
					{
						label: "Deployments",
						href: `/${workspaceSlug}/${project.slug}/deployments`,
						icon: GitPullRequest,
					},
					{
						label: "Logs",
						href: `/${workspaceSlug}/${project.slug}/logs`,
						icon: TerminalSquare,
					},
					{
						label: "Observability",
						href: `/${workspaceSlug}/${project.slug}/observability`,
						icon: BarChart3,
					},
					{
						label: "Domains",
						href: `/${workspaceSlug}/${project.slug}/domains`,
						icon: Globe2,
					},
					{
						label: "Resources",
						href: `/${workspaceSlug}/${project.slug}/resources`,
						icon: Boxes,
					},
					{
						label: "Settings",
						href: `/${workspaceSlug}/${project.slug}/settings`,
						icon: Settings2,
					},
				]
			: workspaceItems;
	const items = project ? projectItems : workspaceItems;
	const breadcrumb = project?.name ?? "Overview";

	return (
		<div className="dt-shell min-h-screen bg-[var(--dt-cloud)] text-[var(--dt-ink)] dark:bg-[var(--dt-night)] dark:text-white">
			<header className="sticky top-0 z-40 border-b border-black/[0.07] bg-[var(--dt-cloud)]/90 backdrop-blur-xl dark:border-white/[0.08] dark:bg-[var(--dt-night)]/88">
				<div className="grid h-16 grid-cols-[1fr_auto_1fr] items-center gap-3 px-3 sm:px-5">
					<div className="min-w-0 justify-self-start">
						<WorkspaceSwitcher />
					</div>
					<div className="min-w-0 text-center">
						<p className="truncate text-xs font-semibold tracking-tight sm:text-sm">
							{breadcrumb}
						</p>
						{project && (
							<p className="hidden text-[9px] font-medium uppercase tracking-[0.2em] text-muted-foreground sm:block">
								Project
							</p>
						)}
					</div>
					<div className="flex min-w-0 items-center justify-end gap-1.5">
						{workspaceSlug && (
							<>
								<button
									type="button"
									className="dt-focus hidden items-center gap-2 rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-xs font-medium shadow-sm transition-colors hover:bg-white md:flex dark:border-white/10 dark:bg-white/[0.06] dark:hover:bg-white/[0.1]"
									onClick={() => router.push(`/${workspaceSlug}/activity`)}
								>
									<span className="relative flex size-2">
										<span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--dt-signal)] opacity-30" />
										<span className="relative inline-flex size-2 rounded-full bg-[var(--dt-signal)]" />
									</span>
									{context?.alertCount ? `${context.alertCount} alerts` : "Status clear"}
								</button>
								<Link
									href="/new"
									className="dt-focus hidden size-9 items-center justify-center rounded-full bg-[var(--dt-warm)] text-white shadow-[0_8px_22px_rgba(217,91,46,0.25)] transition-transform hover:-translate-y-0.5 sm:flex"
									aria-label="Add new project"
								>
									<Plus className="size-4" />
								</Link>
							</>
						)}
						<UserNav />
					</div>
				</div>
				<div className="border-t border-black/[0.05] px-3 py-2 lg:hidden dark:border-white/[0.06]">
					<div className="flex items-center gap-2">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									className="dt-focus flex min-w-0 flex-1 items-center justify-between rounded-lg border bg-background px-3 py-2 text-sm font-medium"
								>
									<span className="flex items-center gap-2 truncate">
										<ListFilter className="size-4 text-muted-foreground" />
										{items.find((item) => isCurrent(pathname, item.href))?.label || "Navigate"}
									</span>
									<ChevronDown className="size-4" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-[min(92vw,22rem)]" align="start">
								<DropdownMenuLabel>{project ? project.name : "Workspace"}</DropdownMenuLabel>
								{items.map((item) => (
									<DropdownMenuItem key={item.href} asChild>
										<Link href={item.href} className="gap-2 py-2.5">
											<item.icon className="size-4" />
											{item.label}
										</Link>
									</DropdownMenuItem>
								))}
								<DropdownMenuSeparator />
								<DropdownMenuItem asChild>
									<Link href="/new" className="gap-2 py-2.5">
										<Plus className="size-4" /> Import project
									</Link>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<button
							type="button"
							className="dt-focus flex size-10 shrink-0 items-center justify-center rounded-lg border bg-background"
							onClick={() => document.dispatchEvent(new CustomEvent("deploytide:search"))}
							aria-label="Search projects"
						>
							<Search className="size-4" />
						</button>
					</div>
				</div>
			</header>

			<div className="mx-auto grid w-full max-w-[1560px] grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)]">
				<aside className="sticky top-16 hidden h-[calc(100vh-4rem)] flex-col border-r border-black/[0.07] px-4 py-5 lg:flex dark:border-white/[0.08]">
					<div className="mb-5 px-3">
						<p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
							{project ? "Project" : "Workspace"}
						</p>
						<p className="mt-1 truncate font-[family-name:var(--font-dt-display)] text-xl font-medium tracking-tight">
							{project?.name || context?.workspace.name || "DeployTide"}
						</p>
					</div>
					<nav aria-label={project ? "Project navigation" : "Workspace navigation"} className="space-y-1">
						{isPending
							? Array.from({ length: 5 }).map((_, index) => (
								<Skeleton key={index} className="h-9 w-full rounded-lg" />
							))
							: items.map((item) => (
								<NavLink key={item.href} item={item} pathname={pathname} />
							))}
					</nav>
					<div className="mt-auto space-y-1 border-t border-black/[0.07] pt-4 dark:border-white/[0.08]">
						<button
							type="button"
							className="dt-focus flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-black/[0.045] hover:text-foreground dark:hover:bg-white/[0.06]"
							onClick={() => document.dispatchEvent(new CustomEvent("deploytide:search"))}
						>
							<Search className="size-4" /> Search
							<kbd className="ml-auto rounded border px-1.5 py-0.5 text-[10px]">/</kbd>
						</button>
						{workspaceSlug && (
							<Link
								href={`/${workspaceSlug}/settings/integrations`}
								className="dt-focus flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-black/[0.045] hover:text-foreground dark:hover:bg-white/[0.06]"
							>
								<FolderGit2 className="size-4" /> Connections
							</Link>
						)}
						<a
							href="https://github.com/mayowaoladosu/DeployTide"
							target="_blank"
							rel="noreferrer"
							className="dt-focus flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-black/[0.045] hover:text-foreground dark:hover:bg-white/[0.06]"
						>
							<BookOpen className="size-4" /> Documentation
						</a>
					</div>
				</aside>
				<main className="min-w-0 px-3 py-5 sm:px-6 sm:py-7 lg:px-8 xl:px-10">
					{children}
				</main>
			</div>
			<div className="pointer-events-none fixed inset-x-0 bottom-0 z-[-1] h-64 bg-[radial-gradient(circle_at_18%_100%,rgba(45,181,127,0.10),transparent_32%),radial-gradient(circle_at_82%_100%,rgba(217,91,46,0.10),transparent_32%)]" />
		</div>
	);
};
