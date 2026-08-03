import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { useRouter } from "next/router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const OperatorLogin = ({ operatorEmail }: { operatorEmail: string }) => {
	const router = useRouter();
	const [accessToken, setAccessToken] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const returnTo =
		typeof router.query.returnTo === "string" &&
		router.query.returnTo.startsWith("/admin/infrastructure")
			? router.query.returnTo
			: "/admin/infrastructure";
	return (
		<main className="min-h-screen bg-[#101512] px-5 py-10 text-[#eff4ef] sm:px-8">
			<div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-6xl overflow-hidden rounded-[2rem] border border-white/10 bg-[#151b17] shadow-[0_40px_120px_rgba(0,0,0,.45)]">
				<section className="relative hidden w-[46%] overflow-hidden border-r border-white/10 p-12 lg:flex lg:flex-col">
					<div className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(255,255,255,.07)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.07)_1px,transparent_1px)] [background-size:32px_32px]" />
					<div className="absolute -left-20 top-1/3 size-80 rounded-full bg-[#63d58b]/15 blur-3xl" />
					<div className="relative">
						<p className="text-xs font-bold uppercase tracking-[.24em] text-[#63d58b]">
							DeployTide operator plane
						</p>
						<h1 className="dt-display mt-8 text-6xl font-medium leading-[.92] tracking-[-.05em]">
							Capacity stays behind the curtain.
						</h1>
						<p className="mt-7 max-w-md text-sm leading-7 text-white/55">
							A separate audience for global providers, regions, build pools,
							runtime clusters, fencing leases and incidents.
						</p>
					</div>
					<div className="relative mt-auto grid gap-3">
						{[
							"No workspace role grants access",
							"No provider secret enters browser state",
							"Every mutation enters the operator ledger",
						].map((item) => (
							<div
								key={item}
								className="flex items-center gap-3 border-t border-white/10 pt-4 text-sm text-white/65"
							>
								<ShieldCheck className="size-4 text-[#63d58b]" />
								{item}
							</div>
						))}
					</div>
				</section>
				<section className="flex flex-1 items-center justify-center p-7 sm:p-12">
					<form
						className="w-full max-w-md"
						onSubmit={async (event) => {
							event.preventDefault();
							setSubmitting(true);
							try {
								const response = await fetch("/api/operator/session", {
									method: "POST",
									credentials: "same-origin",
									cache: "no-store",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ accessToken }),
								});
								if (!response.ok)
									throw new Error("Operator authentication failed");
								await router.replace(returnTo);
							} catch (error) {
								toast.error(
									error instanceof Error
										? error.message
										: "Operator authentication failed",
								);
							} finally {
								setSubmitting(false);
							}
						}}
					>
						<span className="flex size-12 items-center justify-center rounded-xl border border-white/10 bg-white/[.04]">
							<KeyRound className="size-5 text-[#63d58b]" />
						</span>
						<p className="mt-8 text-xs font-bold uppercase tracking-[.2em] text-white/45">
							Superadmin authentication
						</p>
						<h2 className="dt-display mt-3 text-4xl font-medium tracking-[-.04em]">
							Enter the operator plane
						</h2>
						<p className="mt-3 text-sm leading-6 text-white/50">
							Signed in as {operatorEmail}. The access token is exchanged once
							for a short-lived HttpOnly operator session.
						</p>
						<div className="mt-8">
							<Label htmlFor="operator-access-token" className="text-white/70">
								Operator access token
							</Label>
							<Input
								id="operator-access-token"
								type="password"
								autoComplete="off"
								value={accessToken}
								onChange={(event) => setAccessToken(event.target.value)}
								className="mt-2 h-12 border-white/10 bg-white/[.04] text-white"
							/>
						</div>
						<Button
							type="submit"
							disabled={!accessToken || submitting}
							isLoading={submitting}
							className="mt-6 h-12 w-full bg-[#63d58b] text-[#0b130e] hover:bg-[#78e49c]"
						>
							Open infrastructure console{" "}
							<ArrowRight className="ml-auto size-4" />
						</Button>
					</form>
				</section>
			</div>
		</main>
	);
};
