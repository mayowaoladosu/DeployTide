import { CheckCircle2, Circle, LoaderCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export const formatCompactDate = (value: string | Date) =>
	new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
	}).format(new Date(value));

export const formatRelativeTime = (value: string | Date) => {
	const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
	const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		["year", 31_536_000],
		["month", 2_592_000],
		["week", 604_800],
		["day", 86_400],
		["hour", 3_600],
		["minute", 60],
	];
	for (const [unit, divisor] of ranges) {
		if (Math.abs(seconds) >= divisor) {
			return formatter.format(Math.round(seconds / divisor), unit);
		}
	}
	return formatter.format(seconds, "second");
};

export const formatBytes = (value: number) => {
	if (value <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
	return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};

const statusPresentation: Record<
	string,
	{ label: string; className: string; icon: typeof Circle }
> = {
	ready: {
		label: "Ready",
		className: "border-emerald-600/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
		icon: CheckCircle2,
	},
	done: {
		label: "Ready",
		className: "border-emerald-600/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
		icon: CheckCircle2,
	},
	failed: {
		label: "Failed",
		className: "border-red-600/20 bg-red-500/10 text-red-700 dark:text-red-300",
		icon: XCircle,
	},
	error: {
		label: "Failed",
		className: "border-red-600/20 bg-red-500/10 text-red-700 dark:text-red-300",
		icon: XCircle,
	},
	cancelled: {
		label: "Cancelled",
		className: "border-black/10 bg-black/5 text-muted-foreground dark:border-white/10 dark:bg-white/5",
		icon: Circle,
	},
	queued: {
		label: "Queued",
		className: "border-amber-600/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
		icon: LoaderCircle,
	},
	preparing: {
		label: "Preparing",
		className: "border-amber-600/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
		icon: LoaderCircle,
	},
	building: {
		label: "Building",
		className: "border-amber-600/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
		icon: LoaderCircle,
	},
	deploying: {
		label: "Deploying",
		className: "border-sky-600/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
		icon: LoaderCircle,
	},
	checking: {
		label: "Checking",
		className: "border-sky-600/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
		icon: LoaderCircle,
	},
	cancelling: {
		label: "Cancelling",
		className: "border-orange-600/20 bg-orange-500/10 text-orange-700 dark:text-orange-300",
		icon: LoaderCircle,
	},
	idle: {
		label: "Idle",
		className: "border-black/10 bg-black/5 text-muted-foreground dark:border-white/10 dark:bg-white/5",
		icon: Circle,
	},
};

export const ProductStatus = ({
	status,
	className,
}: {
	status?: string | null;
	className?: string;
}) => {
	const presentation = statusPresentation[status || "idle"] || {
		label: status || "Unknown",
		className: statusPresentation.idle?.className || "",
		icon: Circle,
	};
	const Icon = presentation.icon;
	return (
		<span
			className={cn(
				"inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]",
				presentation.className,
				className,
			)}
		>
			<Icon
				className={cn(
					"size-3",
					["queued", "preparing", "building", "deploying", "checking", "cancelling"].includes(
						status || "",
					) && "animate-spin",
				)}
			/>
			{presentation.label}
		</span>
	);
};

export const SectionHeading = ({
	eyebrow,
	title,
	description,
	action,
	level = 2,
}: {
	eyebrow: string;
	title: string;
	description?: string;
	action?: React.ReactNode;
	level?: 1 | 2;
}) => {
	const Heading = level === 1 ? "h1" : "h2";
	return (
	<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
		<div className="max-w-2xl">
			<p className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
				<span className="size-1.5 rotate-45 bg-[var(--dt-warm)]" />
				{eyebrow}
			</p>
			<Heading className="dt-display text-3xl font-medium tracking-[-0.025em] sm:text-4xl">{title}</Heading>
			{description && <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>}
		</div>
		{action}
	</div>
	);
};
