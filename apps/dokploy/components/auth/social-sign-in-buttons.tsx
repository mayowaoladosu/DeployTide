import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

type SocialProvider = "github" | "google";

const labels: Record<SocialProvider, string> = {
	github: "Continue with GitHub",
	google: "Continue with Google",
};

export function SocialSignInButtons() {
	const [pendingProvider, setPendingProvider] =
		useState<SocialProvider | null>(null);

	const signIn = async (provider: SocialProvider) => {
		setPendingProvider(provider);
		try {
			const result = await authClient.signIn.social({
				provider,
				callbackURL: "/dashboard/home",
			});
			if (result.error) {
				toast.error(result.error.message || `Could not sign in with ${provider}`);
			}
		} catch {
			toast.error(`Could not sign in with ${provider}`);
		} finally {
			setPendingProvider(null);
		}
	};

	return (
		<div className="grid gap-2">
			{(["github", "google"] as const).map((provider) => (
				<Button
					key={provider}
					type="button"
					variant="outline"
					className="w-full"
					isLoading={pendingProvider === provider}
					disabled={pendingProvider !== null}
					onClick={() => signIn(provider)}
				>
					{labels[provider]}
				</Button>
			))}
		</div>
	);
}
