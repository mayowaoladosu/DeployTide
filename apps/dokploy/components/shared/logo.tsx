import { cn } from "@/lib/utils";

interface Props {
	className?: string;
	logoUrl?: string;
}

export const Logo = ({ className = "size-14", logoUrl }: Props) => {
	if (logoUrl) {
		return (
			// biome-ignore lint/performance/noImgElement: dynamic organization artwork
			<img
				src={logoUrl}
				alt="Organization logo"
				className={cn(className, "rounded-sm object-contain")}
			/>
		);
	}

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 64 64"
			role="img"
			aria-label="DeployTide"
			className={cn("fill-none stroke-primary", className)}
		>
			<path
				d="M32 25V8m-8 8 8-8 8 8"
				strokeWidth="5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M8 34c6.4-7 12.8-7 19.2 0s12.8 7 19.2 0C49.6 30.5 52.8 28.8 56 29"
				strokeWidth="5"
				strokeLinecap="round"
			/>
			<path
				d="M8 48c6.4-7 12.8-7 19.2 0s12.8 7 19.2 0 12.8-7 19.2 0"
				strokeWidth="5"
				strokeLinecap="round"
			/>
		</svg>
	);
};
