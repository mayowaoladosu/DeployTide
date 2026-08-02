import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface Props {
	status:
		| "queued"
		| "preparing"
		| "building"
		| "deploying"
		| "checking"
		| "ready"
		| "failed"
		| "cancelling"
		| "running"
		| "error"
		| "done"
		| "idle"
		| "cancelled"
		| undefined
		| null;
	className?: string;
}

const statusPresentation: Record<
	NonNullable<Props["status"]>,
	{ label: string; className: string }
> = {
	idle: { label: "Idle", className: "bg-muted-foreground dark:bg-card" },
	queued: { label: "Queued", className: "bg-amber-400" },
	preparing: { label: "Preparing", className: "bg-amber-400" },
	building: { label: "Building", className: "bg-yellow-500" },
	deploying: { label: "Deploying", className: "bg-yellow-500" },
	checking: { label: "Checking", className: "bg-cyan-500" },
	running: { label: "Running", className: "bg-yellow-500" },
	done: { label: "Done", className: "bg-green-500" },
	ready: { label: "Ready", className: "bg-green-500" },
	error: { label: "Error", className: "bg-destructive" },
	failed: { label: "Failed", className: "bg-destructive" },
	cancelling: { label: "Cancelling", className: "bg-orange-500" },
	cancelled: { label: "Cancelled", className: "bg-muted-foreground" },
};

export const StatusTooltip = ({ status, className }: Props) => {
	const presentation = status ? statusPresentation[status] : undefined;
	return (
		<TooltipProvider delayDuration={0}>
			<Tooltip>
				<TooltipTrigger>
					{presentation && (
						<div
							className={cn(
								"size-3.5 rounded-full",
								presentation.className,
								className,
							)}
						/>
					)}
				</TooltipTrigger>
				<TooltipContent align="center">
					<span>{presentation?.label ?? "Unknown"}</span>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
};
