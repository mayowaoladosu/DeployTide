import { LogOut, Moon, Settings, Sun, UserRound } from "lucide-react";
import { useRouter } from "next/router";
import { useTheme } from "next-themes";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { getFallbackAvatarInitials } from "@/lib/utils";
import { api } from "@/utils/api";

export const UserNav = () => {
	const router = useRouter();
	const { theme, setTheme } = useTheme();
	const { data } = api.user.get.useQuery();
	const { data: context } = api.product.context.useQuery();
	const workspaceHref = context?.workspace.slug
		? `/${context.workspace.slug}`
		: "/dashboard/home";

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="dt-focus rounded-full border border-black/10 bg-white/75 p-0.5 shadow-sm transition-transform hover:-translate-y-0.5 dark:border-white/10 dark:bg-white/[0.06]"
					aria-label="Open account menu"
				>
					<Avatar className="size-8">
						<AvatarImage
							src={data?.user?.image || ""}
							alt={data?.user?.firstName || "Account"}
							className="object-cover"
						/>
						<AvatarFallback className="text-xs font-semibold">
							{getFallbackAvatarInitials(
								`${data?.user?.firstName || ""} ${data?.user?.lastName || ""}`.trim() ||
									data?.user?.email ||
									"DT",
							)}
						</AvatarFallback>
					</Avatar>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-64 p-2">
				<DropdownMenuLabel className="px-2 py-2">
					<span className="block truncate font-semibold">
						{[data?.user?.firstName, data?.user?.lastName].filter(Boolean).join(" ") ||
							"Account"}
					</span>
					<span className="block truncate text-xs font-normal text-muted-foreground">
						{data?.user?.email}
					</span>
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => router.push(workspaceHref)} className="gap-2 py-2.5">
					<UserRound className="size-4" /> Workspace
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => router.push("/dashboard/settings/profile")}
					className="gap-2 py-2.5"
				>
					<Settings className="size-4" /> Profile settings
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
					className="gap-2 py-2.5"
				>
					{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
					{theme === "dark" ? "Use light theme" : "Use dark theme"}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					className="gap-2 py-2.5 text-destructive focus:text-destructive"
					onClick={async () => {
						await authClient.signOut();
						await router.push("/");
					}}
				>
					<LogOut className="size-4" /> Log out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
