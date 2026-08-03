import { ArrowUpRight, Bell, CreditCard, FileText, FolderGit2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { ShowNotifications } from "@/components/dashboard/settings/notifications/show-notifications";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { formatCompactDate, SectionHeading } from "../product-shell/product-ui";

export type WorkspaceSettingsSection =
	| "integrations"
	| "notifications"
	| "billing"
	| "invoices";

const WorkspaceConnections = () => {
	const { data, isPending } = api.gitProvider.getAll.useQuery();
	if (isPending) return <Skeleton className="h-64 rounded-2xl" />;
	return (
		<div className="dt-panel overflow-hidden">
			<div className="border-b px-5 py-4">
				<p className="font-semibold">Source connections</p>
				<p className="text-xs text-muted-foreground">Workspace-visible connection status. Sensitive configuration remains platform managed.</p>
			</div>
			{!data?.length ? (
				<div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
					<FolderGit2 className="size-7 text-muted-foreground/50" />
					<p className="mt-3 text-sm font-semibold">No managed connection attached</p>
					<p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">A platform connection will appear here when it is enabled for this workspace. Public HTTPS repositories can be imported immediately.</p>
					<Button asChild size="sm" className="mt-4"><Link href="/new?source=repository">Import public repository</Link></Button>
				</div>
			) : (
				<div className="divide-y">
					{data.map((connection) => {
						const configured =
							connection.github?.isConfigured ||
							connection.gitlab?.isConfigured ||
							Boolean(connection.bitbucket) ||
							Boolean(connection.gitea);
						return (
							<div key={connection.gitProviderId} className="flex items-center gap-4 px-5 py-4">
								<span className="flex size-9 items-center justify-center rounded-lg bg-black/[0.045] dark:bg-white/[0.06]"><FolderGit2 className="size-4" /></span>
								<div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{connection.name}</p><p className="text-xs capitalize text-muted-foreground">{connection.providerType} · {connection.sharedWithOrganization ? "Workspace connection" : "Personal connection"}</p></div>
								<span className={configured ? "text-xs font-semibold text-emerald-600 dark:text-emerald-300" : "text-xs font-semibold text-amber-600 dark:text-amber-300"}>{configured ? "Connected" : "Pending setup"}</span>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};

export const WorkspaceSettings = ({ section }: { section: WorkspaceSettingsSection }) => {
	const { data: context, isPending } = api.product.context.useQuery();
	const { data: plan } = api.stripe.getCurrentPlan.useQuery(undefined, {
		enabled: section === "billing",
	});
	const { data: invoices, isPending: invoicesPending } = api.stripe.getInvoices.useQuery(undefined, {
		enabled: section === "invoices",
	});
	const { mutateAsync: createPortal, isPending: portalPending } =
		api.stripe.createCustomerPortalSession.useMutation();
	if (isPending || !context) return <Skeleton className="h-[60vh] rounded-2xl" />;
	const base = `/${context.workspace.slug}/settings`;
	const sections: Array<[WorkspaceSettingsSection, string, typeof FolderGit2]> = [
		["integrations", "Connections", FolderGit2],
		["notifications", "Notifications", Bell],
		["billing", "Billing", CreditCard],
		["invoices", "Invoices", FileText],
	];
	return (
		<div className="space-y-7 pb-16">
			<SectionHeading level={1} eyebrow="Workspace" title="Workspace settings" description="Connections, notification delivery and commercial account details." />
			<div className="grid gap-6 lg:grid-cols-[210px_minmax(0,1fr)]">
				<nav className="dt-panel h-fit p-2" aria-label="Workspace settings">
					{sections.map(([key, label, Icon]) => (
						<Link key={key} href={`${base}/${key}`} className={cn("dt-focus flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium", section === key ? "bg-[var(--dt-ink)] text-white dark:bg-white dark:text-black" : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]")}><Icon className="size-4" />{label}</Link>
					))}
				</nav>
				<div className="min-w-0">
					{section === "integrations" && <WorkspaceConnections />}
					{section === "notifications" && <ShowNotifications />}
					{section === "billing" && (
						<div className="dt-panel p-6 sm:p-8">
							<div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
								<div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Current plan</p><p className="dt-display mt-3 text-4xl font-medium capitalize">{plan || "Hobby"}</p><p className="mt-2 text-sm text-muted-foreground">Usage is measured at the workspace boundary.</p></div>
								<Button variant="outline" isLoading={portalPending} onClick={async () => { await createPortal().then(({ url }) => { if (url) window.location.assign(url); else toast.info("No billing portal is attached to this workspace."); }).catch((error) => toast.error(error.message)); }}>Open billing portal <ArrowUpRight className="size-4" /></Button>
							</div>
							<div className="mt-8 grid gap-3 sm:grid-cols-3"><div className="rounded-xl border p-4"><p className="text-xs text-muted-foreground">Projects</p><p className="mt-3 text-2xl font-semibold">{context.projects.length}</p></div><div className="rounded-xl border p-4"><p className="text-xs text-muted-foreground">Billing scope</p><p className="mt-3 font-semibold">Workspace</p></div><div className="rounded-xl border p-4"><p className="text-xs text-muted-foreground">Forecast</p><p className="mt-3 font-semibold">Usage details</p></div></div>
						</div>
					)}
					{section === "invoices" && (
						<div className="dt-panel overflow-hidden">
							<div className="border-b px-5 py-4"><p className="font-semibold">Invoice history</p><p className="text-xs text-muted-foreground">Receipts and downloadable invoice records.</p></div>
							{invoicesPending ? <div className="p-5"><Skeleton className="h-40" /></div> : !invoices?.length ? <div className="flex min-h-56 flex-col items-center justify-center text-center"><FileText className="size-7 text-muted-foreground/50" /><p className="mt-3 text-sm font-semibold">No invoices</p><p className="mt-1 text-xs text-muted-foreground">Invoice records appear after the first billable cycle.</p></div> : <div className="divide-y">{invoices.map((invoice) => <div key={invoice.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto_auto] sm:items-center"><div><p className="text-sm font-semibold">{invoice.number || invoice.id}</p><p className="text-xs capitalize text-muted-foreground">{invoice.status} · {formatCompactDate(new Date(invoice.created * 1000))}</p></div><span className="text-sm font-medium">{new Intl.NumberFormat(undefined, { style: "currency", currency: invoice.currency.toUpperCase() }).format(invoice.amountDue / 100)}</span>{invoice.invoicePdf ? <a href={invoice.invoicePdf} target="_blank" rel="noreferrer" className="dt-focus inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--dt-warm)]">Download <ArrowUpRight className="size-3" /></a> : <span className="text-xs text-muted-foreground">Pending</span>}</div>)}</div>}
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
