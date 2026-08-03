import {
	AlertTriangle,
	ArrowUpRight,
	Box,
	Database,
	FileCode2,
	GitBranch,
	GitCommitHorizontal,
	Globe2,
	KeyRound,
	Layers3,
	ListRestart,
	LockKeyhole,
	Rocket,
	TerminalSquare,
	Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import {
	formatRelativeTime,
	SectionHeading as ProductSectionHeading,
	ProductStatus,
} from "../product-shell/product-ui";

export type ProjectSurfaceKind =
	| "deployments"
	| "logs"
	| "observability"
	| "domains"
	| "resources"
	| "settings";

const SectionHeading = (props: React.ComponentProps<typeof ProductSectionHeading>) => (
	<ProductSectionHeading {...props} level={1} />
);

const resourceLabels: Record<string, string> = {
	application: "Application",
	compose: "Compose",
	postgres: "PostgreSQL",
	mariadb: "MariaDB",
	mysql: "MySQL",
	mongo: "MongoDB",
	redis: "Redis",
	libsql: "LibSQL",
};

const Empty = ({ icon: Icon, title, detail, action }: { icon: typeof Rocket; title: string; detail: string; action?: React.ReactNode }) => (
	<div className="dt-panel flex min-h-64 flex-col items-center justify-center px-6 text-center">
		<Icon className="size-7 text-muted-foreground/50" />
		<p className="mt-4 text-sm font-semibold">{title}</p>
		<p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">{detail}</p>
		{action}
	</div>
);

const ProjectSettings = ({
	projectSlug,
	section = "general",
}: {
	projectSlug: string;
	section?: string;
}) => {
	const router = useRouter();
	const utils = api.useUtils();
	const { data, isPending } = api.product.projectOverview.useQuery({ projectSlug });
	const { mutateAsync: update, isPending: updating } = api.project.update.useMutation();
	const { mutateAsync: remove, isPending: removing } = api.project.remove.useMutation();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [description, setDescription] = useState("");
	useEffect(() => {
		if (!data) return;
		setName(data.project.name);
		setSlug(data.project.slug);
		setDescription(data.project.description || "");
	}, [data]);
	if (isPending || !data) return <Skeleton className="h-[60vh] rounded-2xl" />;

	const sections = [
		["general", "General"],
		["git", "Git"],
		["builds", "Builds"],
		["environments", "Environments"],
		["variables", "Variables"],
		["protection", "Protection"],
		["advanced", "Advanced"],
	] as const;
	const base = `/${data.workspace.slug}/${data.project.slug}/settings`;

	return (
		<div className="space-y-7 pb-16">
			<SectionHeading level={1} eyebrow="Project" title="Settings" description="Project identity, source, environments, variables and protection." />
			<div className="grid gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
				<nav className="dt-panel h-fit p-2" aria-label="Project settings">
					{sections.map(([key, label]) => (
						<Link key={key} href={key === "general" ? base : `${base}/${key}`} className={cn("dt-focus block rounded-lg px-3 py-2 text-sm font-medium", section === key ? "bg-[var(--dt-ink)] text-white dark:bg-white dark:text-black" : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]")}>{label}</Link>
					))}
				</nav>
				<div className="dt-panel p-5 sm:p-7">
					{section === "general" && (
						<form className="max-w-xl space-y-5" onSubmit={async (event) => {
							event.preventDefault();
							await update({ projectId: data.project.projectId, name, slug, description })
								.then(async (project) => {
									toast.success("Project updated");
									await utils.product.invalidate();
									if (project?.slug && project.slug !== projectSlug) await router.replace(`/${data.workspace.slug}/${project.slug}/settings`);
								})
								.catch((error) => toast.error(error.message));
						}}>
							<div><Label htmlFor="project-name">Project name</Label><Input id="project-name" className="mt-2" value={name} onChange={(event) => setName(event.target.value)} /></div>
							<div><Label htmlFor="project-slug">Project slug</Label><Input id="project-slug" className="mt-2" value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} /><p className="mt-1 text-xs text-muted-foreground">Stable URL segment for this project.</p></div>
							<div><Label htmlFor="project-description">Description</Label><Textarea id="project-description" className="mt-2 min-h-28" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
							<Button type="submit" isLoading={updating}>Save changes</Button>
						</form>
					)}
					{section === "git" && (
						<div><h3 className="font-semibold">Source connection</h3>{data.source ? <div className="mt-5 rounded-xl border p-5"><div className="flex items-center gap-3"><GitBranch className="size-4 text-muted-foreground" /><div><p className="font-medium">{[data.source.owner, data.source.name].filter(Boolean).join("/") || "Connected source"}</p><p className="text-xs text-muted-foreground">{data.source.provider} · {data.source.branch} · {data.source.rootDirectory}</p></div></div></div> : <Empty icon={GitBranch} title="No source connected" detail="Import a repository to establish a source connection." action={<Button asChild size="sm" className="mt-4"><Link href="/new">Import repository</Link></Button>} />}</div>
					)}
					{section === "builds" && (
						<div><h3 className="font-semibold">Build history</h3><p className="mt-1 text-sm text-muted-foreground">Build settings are versioned with each deployment.</p><div className="mt-5 space-y-2">{data.deployments.slice(0, 8).map((deployment) => <Link key={deployment.deploymentId} href={`/${data.workspace.slug}/${data.project.slug}/${deployment.deploymentId}`} className="dt-focus flex items-center justify-between rounded-lg border p-3 text-sm hover:bg-black/[0.025] dark:hover:bg-white/[0.035]"><span className="truncate">{deployment.sourceMessage || deployment.title}</span><ProductStatus status={deployment.status} /></Link>)}</div></div>
					)}
					{section === "environments" && (
						<div><h3 className="font-semibold">Environments</h3><div className="mt-5 grid gap-3 sm:grid-cols-2">{data.environments.map((environment) => <div key={environment.environmentId} className="rounded-xl border p-4"><p className="font-medium">{environment.name}</p><p className="mt-1 text-xs capitalize text-muted-foreground">{environment.kind} · {environment.retentionDays} day retention</p>{environment.branchPattern && <p className="mt-3 font-mono text-xs text-muted-foreground">{environment.branchPattern}</p>}</div>)}</div></div>
					)}
					{section === "variables" && (
						<div><h3 className="font-semibold">Environment variables</h3><p className="mt-1 text-sm text-muted-foreground">Secret values stay write-only; this screen shows metadata and active versions.</p>{data.variables.length === 0 ? <Empty icon={KeyRound} title="No project variables" detail="Variables appear here after they are added through a project deployment configuration." /> : <div className="mt-5 overflow-hidden rounded-xl border"><div className="divide-y">{data.variables.map((variable) => <div key={variable.environmentVariableId} className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[1fr_auto_auto]"><code>{variable.key}</code><span className="text-xs capitalize text-muted-foreground">{variable.exposure}</span><span className="text-xs text-muted-foreground">v{variable.currentVersion}</span></div>)}</div></div>}</div>
					)}
					{section === "protection" && (
						<div><h3 className="font-semibold">Protection</h3><p className="mt-1 text-sm text-muted-foreground">Environment-level release safeguards and branch policy.</p><div className="mt-5 space-y-3">{data.environments.map((environment) => <div key={environment.environmentId} className="rounded-xl border p-4"><div className="flex items-center gap-2"><LockKeyhole className="size-4 text-muted-foreground" /><p className="font-medium">{environment.name}</p></div><pre className="mt-3 overflow-auto whitespace-pre-wrap rounded-lg bg-black/[0.04] p-3 text-xs text-muted-foreground dark:bg-white/[0.04]">{environment.protectionPolicy ? JSON.stringify(environment.protectionPolicy, null, 2) : "No additional protection policy configured."}</pre></div>)}</div></div>
					)}
					{section === "advanced" && (
						<div><h3 className="font-semibold">Advanced</h3><p className="mt-1 text-sm text-muted-foreground">Project identifier: <code>{data.project.projectId}</code></p><div className="mt-8 rounded-xl border border-red-500/20 bg-red-500/[0.04] p-5"><div className="flex gap-3"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-500" /><div><p className="font-semibold">Delete project</p><p className="mt-1 text-sm leading-6 text-muted-foreground">Deletion is soft-first and preserves retained deployment evidence.</p><Button variant="destructive" className="mt-4" isLoading={removing} onClick={async () => { if (!window.confirm(`Delete ${data.project.name}?`)) return; await remove({ projectId: data.project.projectId }).then(() => router.push(`/${data.workspace.slug}`)).catch((error) => toast.error(error.message)); }}><Trash2 className="size-4" /> Delete project</Button></div></div></div></div>
					)}
				</div>
			</div>
		</div>
	);
};

export const ProjectSurface = ({
	projectSlug,
	kind,
	settingsSection,
}: {
	projectSlug: string;
	kind: ProjectSurfaceKind;
	settingsSection?: string;
}) => {
	const { data, isPending } = api.product.projectOverview.useQuery(
		{ projectSlug },
		{ refetchInterval: kind === "deployments" || kind === "logs" ? 10_000 : 30_000 },
	);
	const [selectedDeploymentId, setSelectedDeploymentId] = useState<string>("");
	useEffect(() => {
		if (!selectedDeploymentId && data?.deployments[0]) setSelectedDeploymentId(data.deployments[0].deploymentId);
	}, [data, selectedDeploymentId]);
	const { data: logText, isFetching: loadingLog } = api.deployment.readLogs.useQuery(
		{ deploymentId: selectedDeploymentId, tail: 500 },
		{ enabled: kind === "logs" && Boolean(selectedDeploymentId), refetchInterval: 5_000 },
	);
	if (kind === "settings") return <ProjectSettings projectSlug={projectSlug} section={settingsSection} />;
	if (isPending || !data) return <Skeleton className="h-[65vh] rounded-2xl" />;

	if (kind === "deployments") {
		return <div className="space-y-7 pb-16"><SectionHeading eyebrow="Project" title="Deployments" description="Immutable production and preview deployment history." />{data.deployments.length === 0 ? <Empty icon={Rocket} title="No deployments yet" detail="Import a source and create the first deployment." action={<Button asChild size="sm" className="mt-4"><Link href="/new">Import source</Link></Button>} /> : <div className="dt-panel overflow-hidden"><ul className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">{data.deployments.map((deployment) => <li key={deployment.deploymentId}><Link href={`/${data.workspace.slug}/${data.project.slug}/${deployment.deploymentId}`} className="dt-focus grid gap-3 px-5 py-4 hover:bg-black/[0.025] sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center dark:hover:bg-white/[0.035]"><div className="min-w-0"><p className="truncate text-sm font-semibold">{deployment.sourceMessage || deployment.title}</p><p className="mt-1 flex items-center gap-2 truncate text-xs text-muted-foreground"><GitBranch className="size-3" />{deployment.sourceBranch || "manual"}<GitCommitHorizontal className="ml-1 size-3" />{deployment.sourceRevision?.slice(0, 8) || "pending"}</p></div><ProductStatus status={deployment.status} /><span className="text-xs text-muted-foreground">{formatRelativeTime(deployment.createdAt)}</span></Link></li>)}</ul></div>}</div>;
	}

	if (kind === "logs") {
		return <div className="space-y-7 pb-16"><SectionHeading eyebrow="Project" title="Runtime logs" description="Read retained output for an authorized deployment." /><div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]"><div className="dt-panel h-fit overflow-hidden"><div className="border-b px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Deployments</div>{data.deployments.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No logs available.</p> : <div className="max-h-[34rem] divide-y overflow-y-auto">{data.deployments.map((deployment) => <button key={deployment.deploymentId} type="button" onClick={() => setSelectedDeploymentId(deployment.deploymentId)} className={cn("dt-focus w-full p-4 text-left hover:bg-black/[0.025] dark:hover:bg-white/[0.035]", selectedDeploymentId === deployment.deploymentId && "bg-black/[0.04] dark:bg-white/[0.05]")}><p className="truncate text-sm font-medium">{deployment.sourceMessage || deployment.title}</p><div className="mt-2 flex items-center justify-between"><ProductStatus status={deployment.status} /><span className="text-[10px] text-muted-foreground">{formatRelativeTime(deployment.createdAt)}</span></div></button>)}</div>}</div><div className="dt-panel min-h-[34rem] overflow-hidden bg-[#0b0f14] text-[#d8e1dc]"><div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/55"><TerminalSquare className="size-3.5" />Deployment output</span><span className="size-2 rounded-full bg-[var(--dt-signal)]" /></div><pre className="custom-logs-scrollbar max-h-[48rem] overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-xs leading-6">{loadingLog ? "Loading retained output…" : logText || "No output was retained for this deployment."}</pre></div></div></div>;
	}

	if (kind === "observability") {
		const metrics = [
			["Requests", data.observability.requests, ""],
			["Error rate", data.observability.errorRate, "%"],
			["Latency", data.observability.latencyMs, "ms"],
			["Restarts", data.observability.restarts, ""],
		] as const;
		return <div className="space-y-7 pb-16"><SectionHeading eyebrow="Project" title="Observability" description="Release health checks summarized without inventing unavailable analytics." /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value, unit]) => <div key={label} className="dt-panel p-5"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{label}</p><p className="mt-8 text-4xl font-semibold tracking-tight">{value === null ? "—" : `${Number.isInteger(value) ? value : value.toFixed(1)}${unit}`}</p><p className="mt-2 text-xs text-muted-foreground">{value === null ? "No telemetry sample in retained release checks" : `${data.observability.sampleCount} retained samples`}</p></div>)}</div><div className="dt-panel p-6"><div className="flex items-center gap-3"><ListRestart className="size-5 text-[var(--dt-signal-deep)] dark:text-[var(--dt-signal)]" /><div><p className="font-semibold">Selectable periods</p><p className="text-sm text-muted-foreground">Only retained release health is available in Phase 3. Request analytics stays hidden until a canonical telemetry source is connected.</p></div></div></div></div>;
	}

	if (kind === "domains") {
		return <div className="space-y-7 pb-16"><SectionHeading eyebrow="Project" title="Domains and aliases" description="Production, branch and preview routes for this project." />{data.domains.length === 0 && data.aliases.length === 0 ? <Empty icon={Globe2} title="No routes yet" detail="A production or preview route appears after the first successful deployment." /> : <div className="grid gap-4 md:grid-cols-2">{data.aliases.map((alias) => <div key={alias.aliasId} className="dt-panel p-5"><div className="flex items-center justify-between"><Globe2 className="size-4 text-muted-foreground" /><ProductStatus status={alias.status} /></div><p className="mt-6 truncate font-semibold">{alias.hostname}</p><p className="mt-1 text-xs capitalize text-muted-foreground">{alias.kind}{alias.branch ? ` · ${alias.branch}` : ""}</p><a href={`https://${alias.hostname}`} target="_blank" rel="noreferrer" className="dt-focus mt-5 inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--dt-warm)]">Visit <ArrowUpRight className="size-3" /></a></div>)}{data.domains.filter((domain) => !data.aliases.some((alias) => alias.hostname === domain.host)).map((domain) => <div key={domain.domainId} className="dt-panel p-5"><div className="flex items-center justify-between"><Globe2 className="size-4 text-muted-foreground" /><span className={domain.https ? "text-xs text-emerald-600 dark:text-emerald-300" : "text-xs text-amber-600 dark:text-amber-300"}>{domain.https ? "Secure" : "Setup required"}</span></div><p className="mt-6 truncate font-semibold">{domain.host}</p><p className="mt-1 text-xs text-muted-foreground">{domain.environmentName || "Environment"} · {domain.type}</p></div>)}</div>}</div>;
	}

	return <div className="space-y-7 pb-16"><SectionHeading eyebrow="Project" title="Resources" description="Applications, databases, schedules, storage and Compose live under this project." action={<Button asChild size="sm"><Link href="/new"><Rocket className="size-4" /> Add application</Link></Button>} />{data.resources.length === 0 ? <Empty icon={Box} title="No resources yet" detail="Import a repository or archive to create the first project application." action={<Button asChild size="sm" className="mt-4"><Link href="/new">Import source</Link></Button>} /> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{data.resources.map((resource) => <div key={resource.id} className="dt-panel p-5"><div className="flex items-center justify-between"><span className="flex size-9 items-center justify-center rounded-lg bg-black/[0.045] dark:bg-white/[0.06]">{resource.type === "application" ? <FileCode2 className="size-4" /> : resource.type === "compose" ? <Layers3 className="size-4" /> : <Database className="size-4" />}</span><ProductStatus status={resource.status} /></div><p className="mt-6 font-semibold">{resource.name}</p><p className="mt-1 line-clamp-2 min-h-10 text-sm text-muted-foreground">{resource.description || `${resourceLabels[resource.type] || resource.type} resource`}</p><div className="mt-5 flex items-center justify-between border-t border-black/[0.06] pt-4 text-xs text-muted-foreground dark:border-white/[0.07]"><span>{resourceLabels[resource.type] || resource.type}</span><span>{resource.environmentName}</span></div></div>)}</div>}</div>;
};
