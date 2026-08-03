import {
	AlertCircle,
	ArrowRight,
	ArrowUpDown,
	Box,
	ChevronDown,
	ExternalLink,
	FileArchive,
	FolderGit2,
	GitCommitHorizontal,
	GitPullRequest,
	Globe2,
	Layers3,
	Plus,
	Search,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/utils/api";
import { api } from "@/utils/api";
import {
	formatBytes,
	formatRelativeTime,
	ProductStatus,
	SectionHeading,
} from "../product-shell/product-ui";

type Overview = RouterOutputs["product"]["workspaceOverview"];
type ProjectCard = Overview["projects"][number];

const UsageCard = ({
	label,
	value,
	detail,
	accent,
}: {
	label: string;
	value: string;
	detail: string;
	accent: "signal" | "warm" | "ink";
}) => (
	<div className="group relative overflow-hidden rounded-xl border border-black/[0.08] bg-white/70 p-4 transition-transform hover:-translate-y-0.5 dark:border-white/[0.08] dark:bg-white/[0.035]">
		<div
			className={cn(
				"absolute inset-x-0 top-0 h-0.5",
				accent === "signal" && "bg-[var(--dt-signal)]",
				accent === "warm" && "bg-[var(--dt-warm)]",
				accent === "ink" && "bg-[var(--dt-ink)] dark:bg-white",
			)}
		/>
		<p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
		<p className="mt-5 text-2xl font-semibold tracking-tight">{value}</p>
		<p className="mt-1 text-xs text-muted-foreground">{detail}</p>
	</div>
);

const ProjectPoster = ({ project }: { project: ProjectCard }) => (
	<div className="relative h-40 overflow-hidden border-b border-black/[0.07] bg-[#111827] p-5 text-white dark:border-white/[0.08]">
		<div className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(255,255,255,.09)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.09)_1px,transparent_1px)] [background-size:24px_24px]" />
		<div className="absolute -right-8 -top-10 size-32 rounded-full bg-[var(--dt-signal)]/30 blur-2xl" />
		<div className="absolute -bottom-14 left-8 size-32 rounded-full bg-[var(--dt-warm)]/25 blur-2xl" />
		<div className="relative flex h-full flex-col justify-between">
			<div className="flex items-center justify-between">
				<span className="rounded-full border border-white/15 bg-white/10 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.17em] text-white/75">
					Production
				</span>
				<ProductStatus status={project.latestDeployment?.status} className="border-white/15 bg-white/10 text-white" />
			</div>
			<div>
				<p className="dt-display text-2xl font-medium tracking-tight">{project.name}</p>
				<div className="mt-2 flex items-center gap-2 text-xs text-white/60">
					<GitCommitHorizontal className="size-3.5" />
					<span className="truncate">
						{project.latestDeployment?.sourceRevision?.slice(0, 8) || "Awaiting first deployment"}
					</span>
				</div>
			</div>
		</div>
	</div>
);

const ProjectTile = ({ project, workspaceSlug }: { project: ProjectCard; workspaceSlug: string }) => (
	<Link
		href={`/${workspaceSlug}/${project.slug}`}
		className="dt-focus group overflow-hidden rounded-2xl border border-black/[0.08] bg-white/80 shadow-[0_16px_45px_rgba(17,24,39,0.05)] transition-all hover:-translate-y-1 hover:shadow-[0_22px_60px_rgba(17,24,39,0.10)] dark:border-white/[0.08] dark:bg-white/[0.035] dark:shadow-none"
	>
		<ProjectPoster project={project} />
		<div className="p-5">
			<div className="flex min-w-0 items-start justify-between gap-4">
				<div className="min-w-0">
					<p className="truncate font-semibold">{project.name}</p>
					<p className="mt-1 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
						{project.description || "A DeployTide project ready for its next release."}
					</p>
				</div>
				<ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
			</div>
			<div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
				<span className="flex items-center gap-1.5">
					<Layers3 className="size-3.5" /> {project.serviceCount} services
				</span>
				{project.productionDomain && (
					<span className="flex min-w-0 items-center gap-1.5">
						<Globe2 className="size-3.5" />
						<span className="max-w-40 truncate">{project.productionDomain}</span>
					</span>
				)}
			</div>
			<div className="mt-5 flex items-center gap-3">
				<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.08]">
					<div
						className="h-full rounded-full bg-[var(--dt-signal)]"
						style={{ width: `${(project.setup.completed / project.setup.total) * 100}%` }}
					/>
				</div>
				<span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
					{project.setup.completed}/{project.setup.total} setup
				</span>
			</div>
			<div className="mt-4 flex items-center justify-between border-t border-black/[0.06] pt-4 text-xs text-muted-foreground dark:border-white/[0.07]">
				<span className="truncate">
					{project.repository?.name
						? [project.repository.owner, project.repository.name].filter(Boolean).join("/")
						: "Source not connected"}
				</span>
				<span className="shrink-0">
					{project.latestDeployment
						? formatRelativeTime(project.latestDeployment.createdAt)
						: "Not deployed"}
				</span>
			</div>
		</div>
	</Link>
);

export const WorkspaceOverview = () => {
	const { data, isPending } = api.product.workspaceOverview.useQuery(undefined, {
		refetchInterval: 20_000,
	});
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<"recent" | "name" | "status">("recent");

	const projects = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const filtered = (data?.projects || []).filter((project) =>
			[project.name, project.description, project.repository?.name, project.productionDomain]
				.filter(Boolean)
				.some((value) => value?.toLowerCase().includes(needle)),
		);
		return [...filtered].sort((left, right) => {
			if (sort === "name") return left.name.localeCompare(right.name);
			if (sort === "status") {
				return (left.latestDeployment?.status || "z").localeCompare(
					right.latestDeployment?.status || "z",
				);
			}
			return (
				new Date(right.latestDeployment?.createdAt || right.createdAt).getTime() -
				new Date(left.latestDeployment?.createdAt || left.createdAt).getTime()
			);
		});
	}, [data?.projects, query, sort]);

	if (isPending || !data) {
		return (
			<div className="space-y-6" aria-label="Loading workspace overview">
				<Skeleton className="h-40 rounded-2xl" />
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
					{Array.from({ length: 4 }).map((_, index) => (
						<Skeleton key={index} className="h-32 rounded-xl" />
					))}
				</div>
			</div>
		);
	}

	const usage = data.usage;
	return (
		<div className="space-y-12 pb-16">
			<section className="dt-panel relative overflow-hidden px-5 py-8 sm:px-8 sm:py-10">
				<div className="absolute -right-16 -top-20 size-64 rounded-full bg-[var(--dt-signal)]/10 blur-3xl" />
				<div className="absolute bottom-0 right-1/4 h-px w-52 bg-gradient-to-r from-transparent via-[var(--dt-warm)] to-transparent" />
				<div className="relative grid gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,.7fr)] lg:items-end">
					<div>
						<p className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
							<Sparkles className="size-3.5 text-[var(--dt-warm)]" />
							{data.workspace.name} / current cycle
						</p>
						<h1 className="dt-display max-w-3xl text-5xl font-medium leading-[0.95] tracking-[-0.045em] sm:text-6xl lg:text-7xl">
							Ship the next version.
						</h1>
						<p className="mt-5 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
							Projects, previews, domains and usage—one clear view of everything moving toward production.
						</p>
					</div>
					<div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
						<div className="relative flex-1">
							<Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search projects…"
								className="h-11 rounded-xl border-black/10 bg-white/80 pl-10 shadow-sm dark:border-white/10 dark:bg-white/[0.05]"
								aria-label="Search projects"
							/>
							<kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
								/
							</kbd>
						</div>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button className="h-11 rounded-xl bg-[var(--dt-warm)] text-white hover:bg-[var(--dt-warm)]/90">
									<Plus className="size-4" /> Add New <ChevronDown className="size-3.5" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-60">
								<DropdownMenuItem asChild className="gap-3 py-2.5">
									<Link href="/new?source=repository">
										<FolderGit2 className="size-4" /> Import repository
									</Link>
								</DropdownMenuItem>
								<DropdownMenuItem asChild className="gap-3 py-2.5">
									<Link href="/new?source=upload">
										<FileArchive className="size-4" /> Import archive
									</Link>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</section>

			<section aria-labelledby="usage-heading">
				<div className="mb-5 flex items-center justify-between">
					<h2 id="usage-heading" className="text-sm font-semibold">Current usage</h2>
					<Link href={`/${data.workspace.slug}/usage`} className="dt-focus text-xs font-medium text-muted-foreground hover:text-foreground">
						View details →
					</Link>
				</div>
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
					<UsageCard label="Builds" value={String(usage.builds)} detail="Runs this cycle" accent="signal" />
					<UsageCard
						label="Edge requests"
						value={usage.edgeRequests === null ? "Not metered" : String(usage.edgeRequests)}
						detail="Meter connects when traffic begins"
						accent="warm"
					/>
					<UsageCard label="Logs" value={String(usage.logStreams)} detail="Deployment streams this cycle" accent="ink" />
					<UsageCard label="Artifacts" value={formatBytes(usage.artifactBytes)} detail={`${usage.artifacts} retained artifacts`} accent="signal" />
				</div>
			</section>

			<section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,.42fr)]">
				<div className="dt-panel overflow-hidden">
					<div className="flex items-center justify-between border-b border-black/[0.07] px-5 py-4 dark:border-white/[0.08]">
						<div>
							<p className="text-sm font-semibold">Recent previews</p>
							<p className="text-xs text-muted-foreground">The latest branch and pull request builds.</p>
						</div>
						<GitPullRequest className="size-4 text-muted-foreground" />
					</div>
					{data.recentPreviews.length === 0 ? (
						<div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
							<GitPullRequest className="size-7 text-muted-foreground/50" />
							<p className="mt-3 text-sm font-medium">No preview activity yet</p>
							<p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">Push a branch or open a pull request after importing a repository.</p>
						</div>
					) : (
						<ul className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
							{data.recentPreviews.slice(0, 6).map((preview) => (
								<li key={preview.previewDeploymentId} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<span className="truncate text-sm font-semibold">{preview.projectName}</span>
											<ProductStatus status={preview.status} />
										</div>
										<p className="mt-1 truncate text-xs text-muted-foreground">
											{preview.branch} · PR #{preview.pullRequestNumber} · {preview.pullRequestTitle}
										</p>
										<p className="mt-1 text-[11px] text-muted-foreground">
											{preview.author || "Repository contributor"} · {preview.commit?.slice(0, 8) || "commit pending"}
										</p>
									</div>
									<div className="flex items-center gap-2">
										{preview.previewUrl && (
											<a href={preview.previewUrl} target="_blank" rel="noreferrer" className="dt-focus rounded-md border p-2 text-muted-foreground hover:text-foreground" aria-label={`Visit ${preview.projectName} preview`}>
												<ExternalLink className="size-3.5" />
											</a>
										)}
										<Link href={`/${data.workspace.slug}/${preview.projectSlug}`} className="dt-focus rounded-md border px-3 py-2 text-xs font-medium">Open project</Link>
									</div>
								</li>
							))}
						</ul>
					)}
				</div>

				<div className="dt-panel overflow-hidden">
					<div className="border-b border-black/[0.07] px-5 py-4 dark:border-white/[0.08]">
						<p className="text-sm font-semibold">Alerts</p>
						<p className="text-xs text-muted-foreground">Only issues that need a workspace action.</p>
					</div>
					{data.alerts.length === 0 ? (
						<div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
							<span className="flex size-10 items-center justify-center rounded-full bg-emerald-500/10">
								<Sparkles className="size-5 text-[var(--dt-signal-deep)] dark:text-[var(--dt-signal)]" />
							</span>
							<p className="mt-3 text-sm font-medium">Everything looks calm</p>
							<p className="mt-1 text-xs leading-5 text-muted-foreground">No deployment or domain action is waiting.</p>
						</div>
					) : (
						<ul className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
							{data.alerts.slice(0, 5).map((alert) => (
								<li key={alert.id} className="px-5 py-4">
									<div className="flex gap-3">
										<AlertCircle className={cn("mt-0.5 size-4 shrink-0", alert.severity === "error" ? "text-red-500" : "text-amber-500")} />
										<div className="min-w-0">
											<p className="text-sm font-medium">{alert.title}</p>
											<p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{alert.detail}</p>
											{alert.projectSlug && <Link href={`/${data.workspace.slug}/${alert.projectSlug}`} className="mt-2 inline-block text-xs font-semibold text-[var(--dt-warm)]">Review →</Link>}
										</div>
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
			</section>

			<section className="space-y-6">
				<SectionHeading
					eyebrow="Projects"
					title="Everything shipping from this workspace"
					description="Production state, repository context and setup progress without infrastructure noise."
					action={
					<div className="flex items-center gap-2">
						<Button variant="outline" size="sm" onClick={() => setSort(sort === "recent" ? "name" : sort === "name" ? "status" : "recent")}>
							<ArrowUpDown className="size-3.5" /> {sort === "recent" ? "Recent" : sort === "name" ? "Name" : "Status"}
						</Button>
					</div>
				}
				/>
				{projects.length === 0 ? (
					<div className="dt-panel flex min-h-72 flex-col items-center justify-center px-6 text-center">
						<span className="flex size-14 items-center justify-center rounded-2xl bg-[var(--dt-ink)] text-white dark:bg-white dark:text-black">
							<Box className="size-6" />
						</span>
						<h3 className="dt-display mt-5 text-3xl font-medium">Import the first project</h3>
						<p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">Connect a repository or upload an archive. DeployTide will create the production environment and prepare the first deployment.</p>
						<Button asChild className="mt-5 bg-[var(--dt-warm)] text-white hover:bg-[var(--dt-warm)]/90">
							<Link href="/new"><Plus className="size-4" /> Add New</Link>
						</Button>
					</div>
				) : (
					<div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
						{projects.map((project) => (
							<ProjectTile key={project.projectId} project={project} workspaceSlug={data.workspace.slug} />
						))}
					</div>
				)}
			</section>
		</div>
	);
};
