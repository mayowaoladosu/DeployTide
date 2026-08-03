import {
	ArrowRight,
	ArrowUpRight,
	Check,
	ChevronDown,
	Circle,
	Clock3,
	ExternalLink,
	GitBranch,
	GitCommitHorizontal,
	GitPullRequest,
	Globe2,
	ListChecks,
	RotateCcw,
	Search,
	Settings2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { formatRelativeTime, ProductStatus, SectionHeading } from "../product-shell/product-ui";

const Metric = ({ label, value, unit }: { label: string; value: number | null; unit?: string }) => (
	<div className="rounded-xl border border-black/[0.07] bg-white/60 p-4 dark:border-white/[0.08] dark:bg-white/[0.025]">
		<p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
		<p className="mt-5 text-2xl font-semibold tracking-tight">
			{value === null ? "—" : `${Number.isInteger(value) ? value : value.toFixed(1)}${unit || ""}`}
		</p>
		<p className="mt-1 text-[11px] text-muted-foreground">{value === null ? "Awaiting telemetry" : "Latest retained samples"}</p>
	</div>
);

export const ProjectOverview = ({ projectSlug }: { projectSlug: string }) => {
	const router = useRouter();
	const utils = api.useUtils();
	const { data, isPending } = api.product.projectOverview.useQuery(
		{ projectSlug },
		{ refetchInterval: 15_000 },
	);
	const { mutateAsync: rollback, isPending: isRollingBack } =
		api.product.rollbackProduction.useMutation();
	const [branchQuery, setBranchQuery] = useState("");
	const [branchStatus, setBranchStatus] = useState<"all" | "ready" | "active" | "failed">("all");

	const branches = useMemo(() => {
		if (!data) return [];
		return data.branches.filter((branch) => {
			const status = branch.deployment?.status || branch.aliasStatus || "active";
			const matchesText = branch.branch.toLowerCase().includes(branchQuery.toLowerCase());
			const matchesStatus =
				branchStatus === "all" ||
				(branchStatus === "active" && !["ready", "failed"].includes(status)) ||
				status === branchStatus;
			return matchesText && matchesStatus;
		});
	}, [data, branchQuery, branchStatus]);

	if (isPending || !data) {
		return <Skeleton className="h-[70vh] rounded-2xl" />;
	}

	const production = data.production;
	const deployment = production.deployment;
	const sourceLabel = data.source?.name
		? [data.source.owner, data.source.name].filter(Boolean).join("/")
		: "Source not connected";
	const sourceUrl =
		data.source?.provider === "git" && typeof data.source.id === "string"
			? data.source.id
			: null;

	return (
		<div className="space-y-12 pb-16">
			<section className="dt-panel overflow-hidden">
				<div className="grid min-h-[390px] lg:grid-cols-[minmax(0,1.15fr)_minmax(350px,.85fr)]">
					<div className="relative overflow-hidden bg-[#111827] p-6 text-white sm:p-8 lg:p-10">
						<div className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(255,255,255,.09)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.09)_1px,transparent_1px)] [background-size:28px_28px]" />
						<div className="absolute -right-10 -top-16 size-64 rounded-full bg-[var(--dt-signal)]/25 blur-3xl" />
						<div className="absolute -bottom-24 left-14 size-64 rounded-full bg-[var(--dt-warm)]/20 blur-3xl" />
						<div className="relative flex h-full flex-col">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<span className="rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.18em] text-white/75">
									Production deployment
								</span>
								<ProductStatus status={deployment?.status} className="border-white/15 bg-white/10 text-white" />
							</div>
							<div className="my-auto py-10">
								<p className="text-xs font-medium uppercase tracking-[0.18em] text-white/45">{data.project.slug}</p>
								<h1 className="dt-display mt-3 max-w-2xl text-5xl font-medium leading-[0.95] tracking-[-0.04em] sm:text-6xl">{data.project.name}</h1>
								<p className="mt-5 max-w-xl text-sm leading-6 text-white/60">{data.project.description || "A production-ready DeployTide project."}</p>
							</div>
							<div className="grid gap-3 text-xs text-white/65 sm:grid-cols-3">
								<span className="flex min-w-0 items-center gap-2"><GitBranch className="size-3.5 shrink-0" /><span className="truncate">{deployment?.sourceBranch || data.source?.branch || "main"}</span></span>
								<span className="flex min-w-0 items-center gap-2"><GitCommitHorizontal className="size-3.5 shrink-0" /><span className="truncate">{deployment?.sourceRevision?.slice(0, 10) || "No commit yet"}</span></span>
								<span className="flex min-w-0 items-center gap-2"><Clock3 className="size-3.5 shrink-0" /><span className="truncate">{deployment ? formatRelativeTime(deployment.createdAt) : "Not deployed"}</span></span>
							</div>
						</div>
					</div>

					<div className="flex flex-col justify-between p-6 sm:p-8 lg:p-10">
						<div>
							<p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Current production</p>
							<div className="mt-5 space-y-4">
								<div>
									<p className="text-xs text-muted-foreground">Repository</p>
									{sourceUrl ? (
										<a href={sourceUrl} target="_blank" rel="noreferrer" className="dt-focus mt-1 inline-flex items-center gap-1.5 text-sm font-semibold hover:text-[var(--dt-warm)]">{sourceLabel}<ExternalLink className="size-3" /></a>
									) : (
										<p className="mt-1 text-sm font-semibold">{sourceLabel}</p>
									)}
								</div>
								<div>
									<p className="text-xs text-muted-foreground">Production URL</p>
									<p className="mt-1 truncate text-sm font-semibold">{production.visitUrl || "Waiting for first route"}</p>
								</div>
								<div>
									<p className="text-xs text-muted-foreground">Immutable deployment</p>
									<p className="mt-1 truncate font-mono text-xs">{deployment?.immutableUrl || deployment?.deploymentId || "Created with the first deployment"}</p>
								</div>
								<div>
									<p className="text-xs text-muted-foreground">Created by</p>
									<p className="mt-1 text-sm font-semibold">{deployment?.sourceAuthor || "Workspace member"}</p>
								</div>
							</div>
						</div>
						<div className="mt-8 grid gap-2 sm:grid-cols-2">
							<Button
								variant="outline"
								disabled={!production.canRollback || isRollingBack}
								isLoading={isRollingBack}
								onClick={async () => {
									await rollback({ projectSlug: data.project.slug })
										.then(async () => {
											toast.success("Production rollback queued");
											await utils.product.projectOverview.invalidate({ projectSlug });
										})
										.catch((error) => toast.error(error.message));
								}}
							>
								<RotateCcw className="size-4" /> Rollback
							</Button>
							{production.visitUrl ? (
								<Button asChild className="bg-[var(--dt-warm)] text-white hover:bg-[var(--dt-warm)]/90">
									<a href={production.visitUrl} target="_blank" rel="noreferrer">Visit <ArrowUpRight className="size-4" /></a>
								</Button>
							) : (
								<Button asChild className="bg-[var(--dt-warm)] text-white hover:bg-[var(--dt-warm)]/90">
									<Link href={data.source ? `/${data.workspace.slug}/${data.project.slug}/deployments` : "/new"}>
										{data.source ? "View deployment" : "Connect source"} <ArrowRight className="size-4" />
									</Link>
								</Button>
							)}
						</div>
					</div>
				</div>
			</section>

			<section className="grid gap-6 xl:grid-cols-[minmax(0,.75fr)_minmax(0,1.25fr)]">
				<Collapsible defaultOpen={data.setup.completed < data.setup.total} className="dt-panel overflow-hidden">
					<CollapsibleTrigger className="dt-focus flex w-full items-center justify-between px-5 py-4 text-left">
						<div className="flex items-center gap-3">
							<span className="flex size-9 items-center justify-center rounded-lg bg-[var(--dt-warm)]/10 text-[var(--dt-warm)]"><ListChecks className="size-4" /></span>
							<div><p className="text-sm font-semibold">Setup checklist</p><p className="text-xs text-muted-foreground">{data.setup.completed} of {data.setup.total} complete</p></div>
						</div>
						<ChevronDown className="size-4 text-muted-foreground transition-transform data-[state=open]:rotate-180" />
					</CollapsibleTrigger>
					<CollapsibleContent>
						<ul className="border-t border-black/[0.07] px-5 py-3 dark:border-white/[0.08]">
							{data.setup.items.map((item) => (
								<li key={item.key} className="flex items-center gap-3 py-2.5 text-sm">
									<span className={cn("flex size-5 items-center justify-center rounded-full border", item.complete ? "border-emerald-500 bg-emerald-500 text-white" : "border-black/15 dark:border-white/20")}>{item.complete ? <Check className="size-3" /> : <Circle className="size-2 fill-current text-muted-foreground/30" />}</span>
									<span className={cn(item.complete && "text-muted-foreground line-through")}>{item.label}</span>
								</li>
							))}
						</ul>
					</CollapsibleContent>
				</Collapsible>

				<div className="dt-panel p-5">
					<div className="flex items-center justify-between">
						<div><p className="text-sm font-semibold">Observability</p><p className="text-xs text-muted-foreground">Health and performance from retained release checks.</p></div>
					<Link href={`/${data.workspace.slug}/${data.project.slug}/observability`} className="dt-focus text-xs font-semibold text-muted-foreground hover:text-foreground">Details →</Link>
					</div>
					<div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
						<Metric label="Requests" value={data.observability.requests} />
						<Metric label="Error rate" value={data.observability.errorRate} unit="%" />
						<Metric label="Latency" value={data.observability.latencyMs} unit="ms" />
						<Metric label="Restarts" value={data.observability.restarts} />
					</div>
				</div>
			</section>

			<section className="space-y-6">
				<SectionHeading eyebrow="Branches" title="Active branches" description="Stable branch aliases, latest deployment state and pull request context." action={<div className="flex gap-2"><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={branchQuery} onChange={(event) => setBranchQuery(event.target.value)} placeholder="Search branches" className="h-9 w-44 pl-9" aria-label="Search branches" /></div><Button variant="outline" size="sm" onClick={() => setBranchStatus(branchStatus === "all" ? "ready" : branchStatus === "ready" ? "active" : branchStatus === "active" ? "failed" : "all")}>{branchStatus}</Button></div>} />
				{branches.length === 0 ? (
					<div className="dt-panel flex min-h-48 flex-col items-center justify-center text-center"><GitBranch className="size-7 text-muted-foreground/50" /><p className="mt-3 text-sm font-semibold">No active branches</p><p className="mt-1 text-xs text-muted-foreground">Branch activity appears after the first repository deployment.</p></div>
				) : (
					<div className="dt-panel overflow-hidden">
						<ul className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
							{branches.map((branch) => (
								<li key={branch.branch} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
									<div className="min-w-0"><p className="flex items-center gap-2 truncate text-sm font-semibold"><GitBranch className="size-3.5" />{branch.branch}</p><p className="mt-1 truncate text-xs text-muted-foreground">{branch.alias || "Alias will be assigned after promotion"}</p></div>
									<ProductStatus status={branch.deployment?.status || branch.aliasStatus} />
									<div className="flex items-center justify-end gap-2">
										{branch.pullRequest && <a href={branch.pullRequest.url} target="_blank" rel="noreferrer" className="dt-focus rounded-md border p-2 text-muted-foreground hover:text-foreground" aria-label={`Open pull request ${branch.pullRequest.number}`}><GitPullRequest className="size-3.5" /></a>}
										{branch.deployment && <Link href={`/${data.workspace.slug}/${data.project.slug}/${branch.deployment.deploymentId}`} className="dt-focus rounded-md border px-3 py-2 text-xs font-medium">Inspect</Link>}
									</div>
								</li>
							))}
						</ul>
					</div>
				)}
			</section>

			<section className="grid gap-4 sm:grid-cols-3">
				<Link href={`/${data.workspace.slug}/${data.project.slug}/deployments`} className="dt-focus dt-panel group p-5"><GitPullRequest className="size-4 text-muted-foreground" /><p className="mt-8 font-semibold">Deployments</p><p className="mt-1 text-xs text-muted-foreground">{data.deployments.length} retained records</p><ArrowRight className="ml-auto mt-4 size-4 transition-transform group-hover:translate-x-1" /></Link>
				<Link href={`/${data.workspace.slug}/${data.project.slug}/domains`} className="dt-focus dt-panel group p-5"><Globe2 className="size-4 text-muted-foreground" /><p className="mt-8 font-semibold">Domains</p><p className="mt-1 text-xs text-muted-foreground">{data.domains.length} project routes</p><ArrowRight className="ml-auto mt-4 size-4 transition-transform group-hover:translate-x-1" /></Link>
				<Link href={`/${data.workspace.slug}/${data.project.slug}/settings`} className="dt-focus dt-panel group p-5"><Settings2 className="size-4 text-muted-foreground" /><p className="mt-8 font-semibold">Project settings</p><p className="mt-1 text-xs text-muted-foreground">Source, environments and variables</p><ArrowRight className="ml-auto mt-4 size-4 transition-transform group-hover:translate-x-1" /></Link>
			</section>
		</div>
	);
};
