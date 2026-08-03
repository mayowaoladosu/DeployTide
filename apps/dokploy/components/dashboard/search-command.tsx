"use client";

import { Activity, FolderGit2, Gauge, Globe2, Plus, Rocket, Search } from "lucide-react";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import { api } from "@/utils/api";

export const SearchCommand = () => {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const { data: session } = api.user.session.useQuery();
	const { data: context } = api.product.context.useQuery(undefined, {
		enabled: Boolean(session),
	});

	useEffect(() => {
		const openSearch = () => setOpen(true);
		const keydown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			const editing =
				target?.tagName === "INPUT" ||
				target?.tagName === "TEXTAREA" ||
				target?.isContentEditable;
			if (
				(!editing && event.key === "/") ||
				(event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey))
			) {
				event.preventDefault();
				setOpen(true);
			}
		};
		document.addEventListener("deploytide:search", openSearch);
		document.addEventListener("keydown", keydown);
		return () => {
			document.removeEventListener("deploytide:search", openSearch);
			document.removeEventListener("keydown", keydown);
		};
	}, []);

	const workspaceItems = useMemo(() => {
		if (!context?.workspace.slug) return [];
		const base = `/${context.workspace.slug}`;
		return [
			{ label: "Workspace overview", href: base, icon: Search },
			{ label: "All deployments", href: `${base}/deployments`, icon: Rocket },
			{ label: "Workspace activity", href: `${base}/activity`, icon: Activity },
			{ label: "Domain inventory", href: `${base}/domains`, icon: Globe2 },
			{ label: "Current usage", href: `${base}/usage`, icon: Gauge },
		];
	}, [context]);

	const go = async (href: string) => {
		setOpen(false);
		setSearch("");
		await router.push(href);
	};

	return (
		<CommandDialog open={open} onOpenChange={setOpen}>
			<CommandInput
				placeholder="Search projects and workspace views…"
				value={search}
				onValueChange={setSearch}
			/>
			<CommandList>
				<CommandEmpty>No matching project or view.</CommandEmpty>
				<CommandGroup heading="Projects">
					{context?.projects.map((project) => (
						<CommandItem
							key={project.projectId}
							value={`${project.name} ${project.slug}`}
							onSelect={() => go(`/${context.workspace.slug}/${project.slug}`)}
							className="gap-3 py-2.5"
						>
							<FolderGit2 className="size-4 text-muted-foreground" />
							<span className="flex-1 truncate">{project.name}</span>
							<span className="text-xs text-muted-foreground">/{project.slug}</span>
						</CommandItem>
					))}
				</CommandGroup>
				<CommandSeparator />
				<CommandGroup heading="Workspace">
					{workspaceItems.map((item) => (
						<CommandItem
							key={item.href}
							onSelect={() => go(item.href)}
							className="gap-3 py-2.5"
						>
							<item.icon className="size-4 text-muted-foreground" />
							{item.label}
						</CommandItem>
					))}
				</CommandGroup>
				<CommandSeparator />
				<CommandGroup heading="Create">
					<CommandItem onSelect={() => go("/new")} className="gap-3 py-2.5">
						<Plus className="size-4 text-[var(--dt-warm)]" /> Import a project
					</CommandItem>
				</CommandGroup>
			</CommandList>
		</CommandDialog>
	);
};
