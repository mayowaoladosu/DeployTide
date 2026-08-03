import {
	Activity,
	ArrowUpRight,
	Box,
	FileText,
	Gauge,
	GitCommitHorizontal,
	Globe2,
	Rocket,
} from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/utils/api";
import {
	formatBytes,
	formatCompactDate,
	formatRelativeTime,
	ProductStatus,
	SectionHeading,
} from "../product-shell/product-ui";

export type WorkspaceSurfaceKind = "deployments" | "activity" | "domains" | "usage";

const Empty = ({ icon: Icon, title, detail }: { icon: typeof Rocket; title: string; detail: string }) => (
	<div className="dt-panel flex min-h-64 flex-col items-center justify-center px-6 text-center">
		<Icon className="size-7 text-muted-foreground/50" />
		<p className="mt-4 text-sm font-semibold">{title}</p>
		<p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{detail}</p>
	</div>
);

export const WorkspaceSurface = ({ kind }: { kind: WorkspaceSurfaceKind }) => {
	const { data, isPending } = api.product.workspaceOverview.useQuery(undefined, {
		refetchInterval: kind === "deployments" ? 10_000 : 30_000,
	});
	if (isPending || !data) {
		return <Skeleton className="h-[65vh] rounded-2xl" />;
	}

	if (kind === "deployments") {
		return (
			<div className="space-y-7 pb-16">
				<SectionHeading level={1} eyebrow="Workspace" title="Deployments" description="Every recent production and preview deployment across accessible projects." />
				{data.recentDeployments.length === 0 ? (
					<Empty icon={Rocket} title="No deployments yet" detail="Import a project to create the first immutable deployment record." />
				) : (
					<div className="dt-panel overflow-hidden">
						<ul className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
							{data.recentDeployments.map((deployment) => (
								<li key={deployment.deploymentId}>
									<Link
										href={deployment.projectSlug ? `/${data.workspace.slug}/${deployment.projectSlug}/${deployment.deploymentId}` : `/${data.workspace.slug}/deployments`}
										className="dt-focus grid gap-3 px-5 py-4 transition-colors hover:bg-black/[0.025] sm:grid-cols-[minmax(0,1.4fr)_minmax(150px,.7fr)_auto] sm:items-center dark:hover:bg-white/[0.035]"
									>
										<div className="min-w-0">
											<div className="flex items-center gap-2">
												<span className="truncate text-sm font-semibold">{deployment.projectName}</span>
												<ProductStatus status={deployment.status} />
											</div>
											<p className="mt-1 truncate text-xs text-muted-foreground">{deployment.sourceMessage || deployment.title}</p>
										</div>
										<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
											<GitCommitHorizontal className="size-3.5 shrink-0" />
											<span className="truncate">{deployment.sourceBranch || "manual"} · {deployment.sourceRevision?.slice(0, 8) || "pending"}</span>
										</div>
										<span className="text-xs text-muted-foreground sm:text-right">{formatRelativeTime(deployment.createdAt)}</span>
									</Link>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
		);
	}

	if (kind === "activity") {
		return (
			<div className="space-y-7 pb-16">
				<SectionHeading level={1} eyebrow="Workspace" title="Activity" description="An audited timeline of project, deployment, domain and collaboration changes." />
				{data.activity.length === 0 ? (
					<Empty icon={Activity} title="No activity recorded" detail="Workspace changes will appear here with their actor and time." />
				) : (
					<div className="dt-panel overflow-hidden">
						<ol className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
							{data.activity.map((entry) => (
								<li key={entry.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
									<span className="flex size-8 items-center justify-center rounded-full bg-black/[0.045] dark:bg-white/[0.06]">
										<Activity className="size-3.5 text-muted-foreground" />
									</span>
									<div className="min-w-0">
										<p className="text-sm"><span className="font-semibold">{entry.actor}</span> {entry.action}d {entry.resourceName || entry.resourceType}</p>
										<p className="mt-1 text-xs capitalize text-muted-foreground">{entry.resourceType} · {entry.actorRole}</p>
									</div>
									<time className="text-xs text-muted-foreground" dateTime={entry.createdAt}>{formatRelativeTime(entry.createdAt)}</time>
								</li>
							))}
						</ol>
					</div>
				)}
			</div>
		);
	}

	if (kind === "domains") {
		return (
			<div className="space-y-7 pb-16">
				<SectionHeading level={1} eyebrow="Workspace" title="Domains" description="Production and preview hostnames grouped across accessible projects." />
				{data.domains.length === 0 ? (
					<Empty icon={Globe2} title="No domains yet" detail="Production and preview domains appear after a project creates its first route." />
				) : (
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						{data.domains.map((domain) => (
							<div key={domain.domainId} className="dt-panel p-5">
								<div className="flex items-start justify-between gap-4">
									<span className="flex size-9 items-center justify-center rounded-lg bg-[var(--dt-signal)]/10 text-[var(--dt-signal-deep)] dark:text-[var(--dt-signal)]">
										<Globe2 className="size-4" />
									</span>
									<a href={`${domain.https ? "https" : "http"}://${domain.host}`} target="_blank" rel="noreferrer" className="dt-focus rounded-md border p-2 text-muted-foreground hover:text-foreground" aria-label={`Visit ${domain.host}`}>
										<ArrowUpRight className="size-3.5" />
									</a>
								</div>
								<p className="mt-5 truncate font-semibold">{domain.host}</p>
								<p className="mt-1 text-xs text-muted-foreground">{domain.projectName} · {domain.environmentName || "Environment"}</p>
								<div className="mt-5 flex items-center justify-between border-t border-black/[0.06] pt-4 text-xs dark:border-white/[0.07]">
									<span className={domain.https ? "text-emerald-600 dark:text-emerald-300" : "text-amber-600 dark:text-amber-300"}>{domain.https ? "Secure" : "Setup required"}</span>
									{domain.projectSlug && <Link href={`/${data.workspace.slug}/${domain.projectSlug}/domains`} className="font-medium text-muted-foreground hover:text-foreground">Manage →</Link>}
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		);
	}

	const meters = [
		{ label: "Build runs", value: String(data.usage.builds), detail: "This cycle", icon: Rocket },
		{ label: "Deployments", value: String(data.usage.deployments), detail: "This cycle", icon: GitCommitHorizontal },
		{ label: "Artifact storage", value: formatBytes(data.usage.artifactBytes), detail: `${data.usage.artifacts} retained`, icon: Box },
		{ label: "Log streams", value: String(data.usage.logStreams), detail: "This cycle", icon: FileText },
	];
	return (
		<div className="space-y-7 pb-16">
			<SectionHeading level={1} eyebrow="Workspace" title="Usage" description={`Current cycle started ${formatCompactDate(data.usage.cycleStart)}. Values come directly from retained workspace records.`} />
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				{meters.map((meter) => (
					<div key={meter.label} className="dt-panel p-5">
						<span className="flex size-9 items-center justify-center rounded-lg bg-black/[0.045] dark:bg-white/[0.06]"><meter.icon className="size-4 text-muted-foreground" /></span>
						<p className="mt-7 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{meter.label}</p>
						<p className="mt-2 text-3xl font-semibold tracking-tight">{meter.value}</p>
						<p className="mt-1 text-xs text-muted-foreground">{meter.detail}</p>
					</div>
				))}
			</div>
			<div className="dt-panel grid gap-6 p-6 lg:grid-cols-[auto_1fr] lg:items-center">
				<span className="flex size-12 items-center justify-center rounded-xl bg-[var(--dt-warm)]/10 text-[var(--dt-warm)]"><Gauge className="size-5" /></span>
				<div>
					<p className="font-semibold">Usage limits are catalog-driven</p>
					<p className="mt-1 text-sm leading-6 text-muted-foreground">This workspace has no local limit record yet. DeployTide shows measured values without inventing allowances; percentage forecasts appear when a versioned plan catalog is attached.</p>
				</div>
			</div>
		</div>
	);
};
