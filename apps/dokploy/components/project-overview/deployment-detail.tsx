import {
	ArrowLeft,
	ArrowUpRight,
	Box,
	CheckCircle2,
	Clock3,
	FileText,
	GitBranch,
	GitCommitHorizontal,
	PackageCheck,
	TerminalSquare,
} from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/utils/api";
import {
	formatBytes,
	formatCompactDate,
	ProductStatus,
	SectionHeading,
} from "../product-shell/product-ui";

export const DeploymentDetail = ({
	projectSlug,
	deploymentId,
}: {
	projectSlug: string;
	deploymentId: string;
}) => {
	const { data, isPending } = api.product.deploymentDetail.useQuery({
		projectSlug,
		deploymentId,
	});
	const { data: logs, isFetching: logsLoading } = api.deployment.readLogs.useQuery({
		deploymentId,
		tail: 500,
	});
	if (isPending || !data) return <Skeleton className="h-[70vh] rounded-2xl" />;
	const deployment = data.deployment;
	return (
		<div className="space-y-8 pb-16">
			<div>
				<Link href={`/${data.workspace.slug}/${data.project.slug}/deployments`} className="dt-focus inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />All deployments</Link>
			</div>
			<SectionHeading level={1} eyebrow="Deployment" title={deployment.sourceMessage || deployment.title} description={`Created ${formatCompactDate(deployment.createdAt)} in ${deployment.environmentName || "the project environment"}.`} action={<ProductStatus status={deployment.status} />} />
			<div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,.8fr)]">
				<div className="dt-panel overflow-hidden">
					<div className="relative min-h-64 overflow-hidden bg-[#111827] p-6 text-white sm:p-8">
						<div className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(255,255,255,.09)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.09)_1px,transparent_1px)] [background-size:26px_26px]" />
						<div className="absolute -right-8 -top-12 size-48 rounded-full bg-[var(--dt-signal)]/25 blur-3xl" />
						<div className="relative flex min-h-52 flex-col justify-between">
							<div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">Immutable deployment</span>{deployment.immutableUrl && <a href={deployment.immutableUrl} target="_blank" rel="noreferrer" className="dt-focus rounded-md border border-white/15 bg-white/10 p-2" aria-label="Visit immutable deployment"><ArrowUpRight className="size-4" /></a>}</div>
							<div><p className="dt-display text-4xl font-medium tracking-tight sm:text-5xl">{data.project.name}</p><p className="mt-3 font-mono text-xs text-white/50">{deployment.deploymentId}</p></div>
							<div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-white/60"><span className="flex items-center gap-2"><GitBranch className="size-3.5" />{deployment.sourceBranch || "manual"}</span><span className="flex items-center gap-2"><GitCommitHorizontal className="size-3.5" />{deployment.sourceRevision?.slice(0, 12) || "pending"}</span><span className="flex items-center gap-2"><Clock3 className="size-3.5" />{deployment.finishedAt ? formatCompactDate(deployment.finishedAt) : "In progress"}</span></div>
						</div>
					</div>
					<div className="grid gap-4 p-5 sm:grid-cols-3">
						<div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Trigger</p><p className="mt-2 text-sm font-semibold capitalize">{deployment.trigger?.replaceAll("_", " ") || "Manual"}</p></div>
						<div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Actor</p><p className="mt-2 truncate text-sm font-semibold">{deployment.sourceAuthor || "Workspace member"}</p></div>
						<div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Environment</p><p className="mt-2 text-sm font-semibold">{deployment.environmentName || "Project environment"}</p></div>
					</div>
				</div>
				<div className="space-y-5">
					<div className="dt-panel p-5"><p className="text-sm font-semibold">Delivery stages</p><div className="mt-5 space-y-3">{data.builds.length === 0 ? <p className="text-sm text-muted-foreground">No separate build attempt was recorded.</p> : data.builds.map((build) => <div key={build.buildId} className="rounded-xl border p-4"><div className="flex items-center justify-between"><span className="flex items-center gap-2 text-sm font-medium"><PackageCheck className="size-4 text-muted-foreground" />Build attempt {build.attempt}</span><ProductStatus status={build.status === "succeeded" ? "ready" : build.status} /></div><p className="mt-2 text-xs text-muted-foreground">{build.preset || "Detected build plan"}</p>{build.artifacts.length > 0 && <div className="mt-3 border-t pt-3">{build.artifacts.map((artifact) => <div key={artifact.artifactId} className="flex items-center justify-between text-xs"><span className="flex items-center gap-2"><Box className="size-3.5" />{artifact.type.toUpperCase()}</span><span className="text-muted-foreground">{formatBytes(artifact.sizeBytes || 0)}</span></div>)}</div>}</div>)}</div></div>
					<div className="dt-panel p-5"><p className="text-sm font-semibold">Release checks</p><div className="mt-5 space-y-3">{data.releases.length === 0 ? <p className="text-sm text-muted-foreground">No release record is attached yet.</p> : data.releases.map((release) => <div key={release.releaseId} className="flex items-center justify-between rounded-xl border p-4"><span className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="size-4 text-muted-foreground" />Attempt {release.attempt}</span><ProductStatus status={release.status} /></div>)}</div></div>
				</div>
			</div>
			<div className="dt-panel overflow-hidden bg-[#0b0f14] text-[#d8e1dc]"><div className="flex items-center justify-between border-b border-white/10 px-5 py-4"><span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/55"><TerminalSquare className="size-3.5" />Retained output</span><FileText className="size-3.5 text-white/35" /></div><pre className="custom-logs-scrollbar max-h-[44rem] overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-xs leading-6">{logsLoading ? "Loading retained output…" : logs || "No output was retained for this deployment."}</pre></div>
		</div>
	);
};
