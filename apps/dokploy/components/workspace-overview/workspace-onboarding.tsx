import { ArrowRight, Check, Layers3, LoaderCircle, Sparkles } from "lucide-react";
import { useRouter } from "next/router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { api } from "@/utils/api";

export const WorkspaceOnboarding = () => {
	const router = useRouter();
	const [name, setName] = useState("");
	const { mutateAsync, isPending } = api.organization.create.useMutation();
	return (
		<main className="dt-shell flex min-h-screen items-center justify-center bg-[var(--dt-cloud)] p-4 dark:bg-[var(--dt-night)]">
			<div className="grid w-full max-w-5xl overflow-hidden rounded-3xl border border-black/[0.08] bg-white/85 shadow-[0_28px_90px_rgba(17,24,39,0.11)] lg:grid-cols-2 dark:border-white/[0.08] dark:bg-white/[0.035] dark:shadow-none">
				<section className="relative overflow-hidden bg-[#111827] p-8 text-white sm:p-12">
					<div className="absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(255,255,255,.1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.1)_1px,transparent_1px)] [background-size:28px_28px]" />
					<div className="absolute -right-12 -top-16 size-64 rounded-full bg-[var(--dt-signal)]/25 blur-3xl" />
					<div className="absolute -bottom-20 left-0 size-64 rounded-full bg-[var(--dt-warm)]/20 blur-3xl" />
					<div className="relative flex min-h-[30rem] flex-col">
						<p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.22em] text-white/55"><Sparkles className="size-3.5 text-[var(--dt-warm)]" />Welcome to DeployTide</p>
						<h1 className="dt-display mt-7 text-5xl font-medium leading-[0.95] tracking-[-0.04em] sm:text-6xl">One workspace. Every release.</h1>
						<p className="mt-5 max-w-md text-sm leading-6 text-white/60">Create a workspace to group projects, teammates, domains and usage. Infrastructure stays managed and out of the way.</p>
						<ul className="mt-auto space-y-4 pt-10 text-sm text-white/70">
							{["Import repositories and archives", "Preview every branch", "Promote and roll back safely"].map((item) => <li key={item} className="flex items-center gap-3"><span className="flex size-6 items-center justify-center rounded-full bg-[var(--dt-signal)]/15 text-[var(--dt-signal)]"><Check className="size-3.5" /></span>{item}</li>)}
						</ul>
					</div>
				</section>
				<section className="flex flex-col justify-center p-8 sm:p-12">
					<span className="flex size-12 items-center justify-center rounded-xl bg-[var(--dt-ink)] text-white dark:bg-white dark:text-black"><Layers3 className="size-5" /></span>
					<h2 className="dt-display mt-7 text-4xl font-medium tracking-tight">Name the workspace</h2>
					<p className="mt-2 text-sm leading-6 text-muted-foreground">Use your company, team or product name. A stable workspace URL is created automatically.</p>
					<form className="mt-8" onSubmit={async (event) => {
						event.preventDefault();
						if (!name.trim()) return;
						await mutateAsync({ name: name.trim() })
							.then(async (workspace) => {
								const result = await authClient.organization.setActive({ organizationId: workspace.id });
								if (result.error) throw new Error(result.error.message);
								toast.success("Workspace created");
								await router.push(`/${workspace.slug}`);
							})
							.catch((error) => toast.error(error instanceof Error ? error.message : "Could not create workspace"));
					}}>
						<Label htmlFor="workspace-name">Workspace name</Label>
						<Input id="workspace-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme" className="mt-2 h-11" autoFocus />
						<Button type="submit" disabled={!name.trim() || isPending} className="mt-5 h-11 w-full bg-[var(--dt-warm)] text-white hover:bg-[var(--dt-warm)]/90">{isPending ? <LoaderCircle className="size-4 animate-spin" /> : <>Create workspace <ArrowRight className="ml-auto size-4" /></>}</Button>
					</form>
				</section>
			</div>
		</main>
	);
};
