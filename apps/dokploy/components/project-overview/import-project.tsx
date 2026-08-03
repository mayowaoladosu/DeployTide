import {
	ArrowLeft,
	ArrowRight,
	Check,
	FileArchive,
	FolderGit2,
	GitBranch,
	Globe2,
	LoaderCircle,
	UploadCloud,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dropzone } from "@/components/ui/dropzone";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

export const ImportProject = () => {
	const router = useRouter();
	const { data: context } = api.product.context.useQuery();
	const preferred = router.query.source === "upload" ? "upload" : "repository";
	const [mode, setMode] = useState<"repository" | "upload">(
		preferred,
	);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [repositoryUrl, setRepositoryUrl] = useState("");
	const [branch, setBranch] = useState("main");
	const [rootDirectory, setRootDirectory] = useState("/");
	const [archive, setArchive] = useState<File | null>(null);
	const [stage, setStage] = useState<"idle" | "creating" | "uploading" | "deploying">("idle");
	const { mutateAsync: importProject } = api.product.importProject.useMutation();
	const { mutateAsync: cleanupFailedImport } =
		api.product.cleanupFailedImport.useMutation();
	const { mutateAsync: upload } = api.application.dropDeployment.useMutation();

	const busy = stage !== "idle";
	const valid =
		name.trim().length > 0 &&
		(mode === "repository" ? repositoryUrl.trim().length > 0 : Boolean(archive));

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!valid) return;
		setStage("creating");
		let createdProjectId: string | null = null;
		let cleanupAuthorization: { expiresAt: number; proof: string } | null = null;
		try {
			const result = await importProject({
				mode,
				name: name.trim(),
				description: description.trim() || undefined,
				repositoryUrl: mode === "repository" ? repositoryUrl.trim() : undefined,
				branch,
				rootDirectory,
			});
			createdProjectId = result.project.projectId;
			if (result.cleanupExpiresAt && result.cleanupProof) {
				cleanupAuthorization = {
					expiresAt: result.cleanupExpiresAt,
					proof: result.cleanupProof,
				};
			}
			if (mode === "upload" && archive) {
				setStage("uploading");
				const body = new FormData();
				body.append("zip", archive);
				body.append("applicationId", result.applicationId);
				if (rootDirectory !== "/") body.append("dropBuildPath", rootDirectory);
				await upload(body);
			}
			toast.success(mode === "upload" ? "Archive imported" : "Repository imported and deployment queued");
			await router.push(`/${context?.workspace.slug || "dashboard"}/${result.project.slug}`);
		} catch (error) {
			if (createdProjectId && cleanupAuthorization) {
				try {
					await cleanupFailedImport({
						projectId: createdProjectId,
						expiresAt: cleanupAuthorization.expiresAt,
						proof: cleanupAuthorization.proof,
					});
				} catch (cleanupError) {
					toast.error(
						cleanupError instanceof Error
							? cleanupError.message
							: "Import failed and partial records could not be retired",
					);
				}
			}
			toast.error(error instanceof Error ? error.message : "Import failed");
			setStage("idle");
		}
	};

	const stageLabel =
		stage === "creating"
			? "Creating project"
			: stage === "uploading"
				? "Uploading archive"
				: stage === "deploying"
					? "Queueing deployment"
					: "Import and deploy";

	return (
		<div className="mx-auto max-w-5xl pb-16">
			<Link href={context?.workspace.slug ? `/${context.workspace.slug}` : "/dashboard/home"} className="dt-focus inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground">
				<ArrowLeft className="size-3.5" /> Back to workspace
			</Link>
			<div className="mt-6 grid overflow-hidden rounded-3xl border border-black/[0.08] bg-white/80 shadow-[0_24px_80px_rgba(17,24,39,0.08)] lg:grid-cols-[minmax(320px,.75fr)_minmax(0,1.25fr)] dark:border-white/[0.08] dark:bg-white/[0.035] dark:shadow-none">
				<div className="relative overflow-hidden bg-[#111827] p-7 text-white sm:p-9">
					<div className="absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(255,255,255,.1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.1)_1px,transparent_1px)] [background-size:26px_26px]" />
					<div className="absolute -right-12 -top-16 size-56 rounded-full bg-[var(--dt-signal)]/25 blur-3xl" />
					<div className="absolute -bottom-20 left-2 size-56 rounded-full bg-[var(--dt-warm)]/20 blur-3xl" />
					<div className="relative flex h-full min-h-[32rem] flex-col">
						<p className="text-[10px] font-bold uppercase tracking-[0.22em] text-white/50">New project</p>
						<h1 className="dt-display mt-5 text-5xl font-medium leading-[0.96] tracking-[-0.04em]">From source to production.</h1>
						<p className="mt-5 text-sm leading-6 text-white/60">Import a public repository or a zip archive. DeployTide creates the project, production environment and first application without infrastructure setup.</p>
						<ol className="mt-auto space-y-4 pt-10 text-sm text-white/70">
							{[
								["1", "Connect source"],
								["2", "Create production environment"],
								["3", "Queue the first deployment"],
							].map(([number, label]) => (
								<li key={number} className="flex items-center gap-3"><span className="flex size-7 items-center justify-center rounded-full border border-white/15 bg-white/10 text-xs font-semibold">{number}</span>{label}</li>
							))}
						</ol>
					</div>
				</div>

				<form onSubmit={submit} className="p-6 sm:p-9">
					<div className="grid grid-cols-2 gap-2 rounded-xl bg-black/[0.04] p-1 dark:bg-white/[0.05]">
						<button type="button" onClick={() => setMode("repository")} className={cn("dt-focus flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors", mode === "repository" ? "bg-white shadow-sm dark:bg-white/10" : "text-muted-foreground")}><FolderGit2 className="size-4" />Repository</button>
						<button type="button" onClick={() => setMode("upload")} className={cn("dt-focus flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors", mode === "upload" ? "bg-white shadow-sm dark:bg-white/10" : "text-muted-foreground")}><FileArchive className="size-4" />Archive</button>
					</div>
					<div className="mt-7 space-y-5">
						<div><Label htmlFor="import-name">Project name</Label><Input id="import-name" className="mt-2 h-11" value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme storefront" autoFocus /></div>
						<div><Label htmlFor="import-description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label><Textarea id="import-description" className="mt-2 min-h-20" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this project ships" /></div>
						{mode === "repository" ? (
							<>
								<div><Label htmlFor="repository-url">HTTPS repository URL</Label><div className="relative mt-2"><Globe2 className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="repository-url" className="h-11 pl-10" type="url" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/organization/repository.git" /></div><p className="mt-1 text-xs text-muted-foreground">Use a credential-free URL. Private provider connections can be attached from workspace connections.</p></div>
								<div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor="repository-branch">Production branch</Label><div className="relative mt-2"><GitBranch className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input id="repository-branch" className="pl-9" value={branch} onChange={(event) => setBranch(event.target.value)} /></div></div><div><Label htmlFor="repository-root">Root directory</Label><Input id="repository-root" className="mt-2" value={rootDirectory} onChange={(event) => setRootDirectory(event.target.value)} /></div></div>
							</>
						) : (
							<div><Label>Zip archive</Label><div className="mt-2"><Dropzone accept=".zip" dropMessage="Drop a zip archive or choose a file" onChange={(value) => setArchive(value?.[0] || null)} /></div>{archive && <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Check className="size-3.5 text-[var(--dt-signal-deep)] dark:text-[var(--dt-signal)]" />{archive.name} · {(archive.size / 1024 / 1024).toFixed(2)} MB</p>}<div className="mt-4"><Label htmlFor="archive-root">Build directory</Label><Input id="archive-root" className="mt-2" value={rootDirectory} onChange={(event) => setRootDirectory(event.target.value)} /></div></div>
						)}
					</div>
					<Button type="submit" disabled={!valid || busy} className="mt-8 h-11 w-full bg-[var(--dt-warm)] text-white hover:bg-[var(--dt-warm)]/90">
						{busy ? <LoaderCircle className="size-4 animate-spin" /> : mode === "upload" ? <UploadCloud className="size-4" /> : <FolderGit2 className="size-4" />}
						{stageLabel}{!busy && <ArrowRight className="ml-auto size-4" />}
					</Button>
				</form>
			</div>
		</div>
	);
};
