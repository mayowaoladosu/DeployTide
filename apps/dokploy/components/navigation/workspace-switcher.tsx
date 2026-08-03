import { Check, ChevronDown } from "lucide-react";
import { useRouter } from "next/router";
import { toast } from "sonner";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { api } from "@/utils/api";
import { AddOrganization } from "../dashboard/organization/handle-organization";
import { Logo } from "../shared/logo";

export const WorkspaceSwitcher = () => {
	const router = useRouter();
	const { data: organizations } = api.organization.all.useQuery();
	const { data: active } = api.organization.active.useQuery();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="dt-focus flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.045] dark:hover:bg-white/[0.06]"
					aria-label="Switch workspace"
				>
					<span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-black/10 bg-white shadow-sm dark:border-white/10 dark:bg-white/5">
						<Logo className="size-4" logoUrl={active?.logo || undefined} />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-sm font-semibold text-[var(--dt-ink)] dark:text-white">
							{active?.name || "Workspace"}
						</span>
						<span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
							Workspace
						</span>
					</span>
					<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72 p-2">
				<DropdownMenuLabel className="px-2 pb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
					Your workspaces
				</DropdownMenuLabel>
				{organizations?.map((workspace) => (
					<DropdownMenuItem
						key={workspace.id}
						className="gap-3 rounded-md p-2.5"
						onClick={async () => {
							if (workspace.id === active?.id) return;
							const result = await authClient.organization.setActive({
								organizationId: workspace.id,
							});
							if (result.error) {
								toast.error(result.error.message || "Could not switch workspace");
								return;
							}
							await router.push(`/${workspace.slug}`);
						}}
					>
						<span className="flex size-8 items-center justify-center rounded-md border bg-background">
							<Logo className="size-4" logoUrl={workspace.logo || undefined} />
						</span>
						<span className="min-w-0 flex-1 truncate font-medium">
							{workspace.name}
						</span>
						{workspace.id === active?.id && (
							<Check className="size-4 text-[var(--dt-signal)]" />
						)}
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<AddOrganization />
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
