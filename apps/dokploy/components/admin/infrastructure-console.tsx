import {
	AlertTriangle,
	ArchiveRestore,
	Boxes,
	Building2,
	ChevronRight,
	CircleGauge,
	CloudCog,
	Cpu,
	DatabaseZap,
	Gauge,
	GitCommitHorizontal,
	Globe2,
	KeyRound,
	Layers3,
	MapPinned,
	RefreshCcw,
	ServerCog,
	ShieldCheck,
	TriangleAlert,
	Workflow,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import type { FormEvent, ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { clearOperatorApiSession, operatorApi } from "@/utils/api";

export type InfrastructureSection =
	| "overview"
	| "providers"
	| "regions"
	| "build-pools"
	| "runtime-clusters"
	| "capacity"
	| "versions"
	| "drains"
	| "incidents"
	| "certificates"
	| "migration";

const navigation: Array<{
	section: InfrastructureSection;
	label: string;
	icon: typeof CloudCog;
}> = [
	{ section: "overview", label: "Overview", icon: CircleGauge },
	{ section: "providers", label: "Providers", icon: CloudCog },
	{ section: "regions", label: "Regions", icon: MapPinned },
	{ section: "build-pools", label: "Build pools", icon: Cpu },
	{ section: "runtime-clusters", label: "Runtime clusters", icon: Layers3 },
	{ section: "capacity", label: "Capacity", icon: Gauge },
	{ section: "versions", label: "Versions", icon: GitCommitHorizontal },
	{ section: "drains", label: "Drains", icon: ArchiveRestore },
	{ section: "incidents", label: "Incidents", icon: AlertTriangle },
	{ section: "certificates", label: "Certificates", icon: KeyRound },
	{ section: "migration", label: "Legacy intake", icon: DatabaseZap },
];

const fieldClass =
	"h-10 border-white/10 bg-black/20 text-sm text-white placeholder:text-white/25";
const selectClass =
	"h-10 w-full rounded-md border border-white/10 bg-[#111713] px-3 text-sm text-white outline-none focus:border-[#63d58b]/60";

const textValue = (form: FormData, name: string) =>
	String(form.get(name) ?? "").trim();
const numberValue = (form: FormData, name: string) =>
	Number(textValue(form, name));

const ActionForm = ({
	title,
	detail,
	submitLabel,
	busy,
	onSubmit,
	children,
}: {
	title: string;
	detail: string;
	submitLabel: string;
	busy?: boolean;
	onSubmit: (form: FormData) => Promise<void>;
	children: ReactNode;
}) => (
	<form
		className="rounded-2xl border border-white/10 bg-white/[.035] p-5"
		onSubmit={async (event: FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			await onSubmit(new FormData(event.currentTarget));
		}}
	>
		<div>
			<h2 className="text-sm font-semibold">{title}</h2>
			<p className="mt-1 text-xs leading-5 text-white/40">{detail}</p>
		</div>
		<div className="mt-5 grid gap-4 sm:grid-cols-2">{children}</div>
		<Button
			type="submit"
			size="sm"
			isLoading={busy}
			className="mt-5 bg-[#63d58b] text-[#0a120d] hover:bg-[#78e49c]"
		>
			{submitLabel}
		</Button>
	</form>
);

const Field = ({
	name,
	label,
	type = "text",
	placeholder,
	required = true,
	defaultValue,
}: {
	name: string;
	label: string;
	type?: string;
	placeholder?: string;
	required?: boolean;
	defaultValue?: string | number;
}) => (
	<div>
		<Label htmlFor={name} className="text-xs text-white/55">
			{label}
		</Label>
		<Input
			id={name}
			name={name}
			type={type}
			placeholder={placeholder}
			required={required}
			defaultValue={defaultValue}
			className={`mt-1.5 ${fieldClass}`}
		/>
	</div>
);

const statusTone = (status: string) => {
	if (
		["ready", "healthy", "active", "succeeded", "resolved", "clean"].includes(
			status,
		)
	) {
		return "border-emerald-400/20 bg-emerald-400/10 text-emerald-300";
	}
	if (
		["degraded", "draining", "monitoring", "warning", "reconciling"].includes(
			status,
		)
	) {
		return "border-amber-400/20 bg-amber-400/10 text-amber-200";
	}
	if (["unavailable", "failed", "critical", "revoked"].includes(status)) {
		return "border-red-400/20 bg-red-400/10 text-red-300";
	}
	return "border-white/10 bg-white/[.05] text-white/60";
};

const Status = ({ value }: { value: string }) => (
	<span
		className={cn(
			"rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.14em]",
			statusTone(value),
		)}
	>
		{value.replaceAll("_", " ")}
	</span>
);

const Empty = ({ title, detail }: { title: string; detail: string }) => (
	<div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[.02] px-6 text-center">
		<Boxes className="size-6 text-white/25" />
		<p className="mt-4 text-sm font-semibold">{title}</p>
		<p className="mt-1 max-w-md text-xs leading-5 text-white/40">{detail}</p>
	</div>
);

const Metric = ({
	label,
	value,
	detail,
	icon: Icon,
}: {
	label: string;
	value: string | number;
	detail: string;
	icon: typeof Cpu;
}) => (
	<div className="rounded-2xl border border-white/10 bg-white/[.035] p-5">
		<div className="flex items-start justify-between">
			<p className="text-[10px] font-bold uppercase tracking-[.18em] text-white/40">
				{label}
			</p>
			<Icon className="size-4 text-[#63d58b]" />
		</div>
		<p className="dt-display mt-8 text-4xl font-medium tracking-[-.04em]">
			{value}
		</p>
		<p className="mt-1 text-xs text-white/40">{detail}</p>
	</div>
);

export const InfrastructureConsole = ({
	section,
	operatorEmail,
}: {
	section: InfrastructureSection;
	operatorEmail: string;
}) => {
	const router = useRouter();
	const utils = operatorApi.useUtils();
	const { data, isPending } = operatorApi.infrastructure.overview.useQuery(
		undefined,
		{
			refetchInterval: 15_000,
		},
	);
	const bootstrap = operatorApi.infrastructure.bootstrapLocal.useMutation();
	const reconcile = operatorApi.infrastructure.reconcileLeases.useMutation();
	const probe = operatorApi.infrastructure.probeProvider.useMutation();
	const createProvider =
		operatorApi.infrastructure.createProvider.useMutation();
	const rotateProviderSecret =
		operatorApi.infrastructure.rotateProviderSecret.useMutation();
	const createRegion = operatorApi.infrastructure.createRegion.useMutation();
	const createBuildPool =
		operatorApi.infrastructure.createBuildPool.useMutation();
	const drainBuildPool =
		operatorApi.infrastructure.drainBuildPool.useMutation();
	const reconcileBuildPoolDrain =
		operatorApi.infrastructure.reconcileBuildPoolDrain.useMutation();
	const restoreBuildPool =
		operatorApi.infrastructure.restoreBuildPool.useMutation();
	const createRuntimeCluster =
		operatorApi.infrastructure.createRuntimeCluster.useMutation();
	const createRuntimeTarget =
		operatorApi.infrastructure.createRuntimeTarget.useMutation();
	const drain = operatorApi.infrastructure.drainCluster.useMutation();
	const reconcileDrain =
		operatorApi.infrastructure.reconcileDrain.useMutation();
	const restore = operatorApi.infrastructure.restoreCluster.useMutation();
	const createIncident =
		operatorApi.infrastructure.createIncident.useMutation();
	const resolveIncident =
		operatorApi.infrastructure.resolveIncident.useMutation();
	const classifyLegacy =
		operatorApi.infrastructure.classifyLegacy.useMutation();
	const exportLegacy = operatorApi.infrastructure.exportLegacy.useMutation();
	const importLegacy = operatorApi.infrastructure.importLegacy.useMutation();
	const retireBootstrap =
		operatorApi.infrastructure.retireBootstrap.useMutation();
	const registerCertificate =
		operatorApi.infrastructure.registerCertificate.useMutation();
	const revokeCertificate =
		operatorApi.infrastructure.revokeCertificate.useMutation();
	const buildPoolLifecycleBusy =
		drainBuildPool.isPending ||
		reconcileBuildPoolDrain.isPending ||
		restoreBuildPool.isPending;
	const refresh = async () => utils.infrastructure.overview.invalidate();
	const mutate = async (promise: Promise<unknown>, message: string) => {
		await promise
			.then(async () => {
				toast.success(message);
				await refresh();
			})
			.catch((error) => toast.error(error.message));
	};

	if (isPending || !data) {
		return (
			<div className="min-h-screen bg-[#101512] p-8">
				<Skeleton className="mx-auto h-[80vh] max-w-7xl bg-white/5" />
			</div>
		);
	}
	const totalBuild = data.buildPools.reduce(
		(sum, pool) => sum + pool.totalCapacity,
		0,
	);
	const reservedBuild = data.buildPools.reduce(
		(sum, pool) => sum + pool.reservedCapacity,
		0,
	);
	const totalCpu = data.runtimeClusters.reduce(
		(sum, cluster) => sum + cluster.totalCpuMillis,
		0,
	);
	const reservedCpu = data.runtimeClusters.reduce(
		(sum, cluster) => sum + cluster.reservedCpuMillis,
		0,
	);
	const unhealthy =
		data.providers.filter((provider) => provider.health !== "healthy").length +
		data.runtimeClusters.filter((cluster) => cluster.health !== "healthy")
			.length;

	const lifecycleAction = (() => {
		if (section === "providers") {
			return (
				<ActionForm
					title="Register production provider"
					detail="Only an allowlisted HTTPS host and an opaque configured secret ID are accepted. Neither value is returned by the API."
					submitLabel="Register provider"
					busy={createProvider.isPending}
					onSubmit={(form) =>
						mutate(
							createProvider.mutateAsync({
								name: textValue(form, "provider-name"),
								adapterType: "layerrail-compute",
								endpointReference: textValue(form, "provider-endpoint"),
								secretId: textValue(form, "provider-secret-id"),
								capabilities: textValue(form, "provider-capabilities")
									.split(",")
									.map((value) => value.trim())
									.filter(Boolean),
								version: textValue(form, "provider-version"),
							}),
							"Provider registered",
						)
					}
				>
					<Field
						name="provider-name"
						label="Display name"
						placeholder="LayerRail production"
					/>
					<Field
						name="provider-endpoint"
						label="HTTPS API endpoint"
						type="url"
						placeholder="https://compute.example.com"
					/>
					<Field
						name="provider-secret-id"
						label="Opaque secret ID"
						placeholder="layerrail-primary"
					/>
					<Field
						name="provider-version"
						label="Expected version"
						placeholder="2026.8"
					/>
					<div className="sm:col-span-2">
						<Field
							name="provider-capabilities"
							label="Capabilities (comma separated)"
							placeholder="runtime.container, build.rootless"
						/>
					</div>
				</ActionForm>
			);
		}
		if (section === "regions") {
			return (
				<ActionForm
					title="Create region"
					detail="A provider must pass a fresh health probe before a region can enter service."
					submitLabel="Create region"
					busy={createRegion.isPending}
					onSubmit={(form) =>
						mutate(
							createRegion.mutateAsync({
								infrastructureProviderId: textValue(form, "region-provider"),
								code: textValue(form, "region-code"),
								name: textValue(form, "region-name"),
								providerRegionReference: textValue(
									form,
									"region-provider-reference",
								),
								buildAvailable: form.has("region-build"),
								runtimeAvailable: form.has("region-runtime"),
								residencyMetadata: {
									residency: textValue(form, "region-residency"),
								},
							}),
							"Region created",
						)
					}
				>
					<div>
						<Label htmlFor="region-provider" className="text-xs text-white/55">
							Provider
						</Label>
						<select
							id="region-provider"
							name="region-provider"
							required
							className={`mt-1.5 ${selectClass}`}
						>
							{data.providers.map((provider) => (
								<option
									key={provider.infrastructureProviderId}
									value={provider.infrastructureProviderId}
								>
									{provider.name}
								</option>
							))}
						</select>
					</div>
					<Field
						name="region-code"
						label="Stable region code"
						placeholder="east-us"
					/>
					<Field name="region-name" label="Region name" placeholder="East US" />
					<Field
						name="region-provider-reference"
						label="Provider region mapping"
						placeholder="us-east"
					/>
					<Field
						name="region-residency"
						label="Residency"
						placeholder="United States"
					/>
					<div className="flex items-end gap-5 pb-2 text-xs text-white/55">
						<label className="flex items-center gap-2">
							<input name="region-build" type="checkbox" /> Build plane
						</label>
						<label className="flex items-center gap-2">
							<input name="region-runtime" type="checkbox" defaultChecked />{" "}
							Runtime plane
						</label>
					</div>
				</ActionForm>
			);
		}
		if (section === "build-pools") {
			return (
				<ActionForm
					title="Create rootless build pool"
					detail="Pools are dedicated to ephemeral rootless BuildKit work and are bounded by operator capacity."
					submitLabel="Create build pool"
					busy={createBuildPool.isPending}
					onSubmit={(form) =>
						mutate(
							createBuildPool.mutateAsync({
								infrastructureProviderId: textValue(form, "pool-provider"),
								regionId: textValue(form, "pool-region"),
								name: textValue(form, "pool-name"),
								adapterType: "rootless-buildkit",
								architecture: textValue(form, "pool-architecture") as
									| "amd64"
									| "arm64",
								workerClass: textValue(form, "pool-class"),
								minCapacity: numberValue(form, "pool-min"),
								maxCapacity: numberValue(form, "pool-max"),
								totalCapacity: numberValue(form, "pool-total"),
								cacheNamespace: textValue(form, "pool-cache"),
								endpointReference: textValue(form, "pool-endpoint") || null,
								version: textValue(form, "pool-version"),
							}),
							"Build pool created",
						)
					}
				>
					<div>
						<Label htmlFor="pool-provider" className="text-xs text-white/55">
							Provider
						</Label>
						<select
							id="pool-provider"
							name="pool-provider"
							required
							className={`mt-1.5 ${selectClass}`}
						>
							{data.providers.map((provider) => (
								<option
									key={provider.infrastructureProviderId}
									value={provider.infrastructureProviderId}
								>
									{provider.name}
								</option>
							))}
						</select>
					</div>
					<div>
						<Label htmlFor="pool-region" className="text-xs text-white/55">
							Build region
						</Label>
						<select
							id="pool-region"
							name="pool-region"
							required
							className={`mt-1.5 ${selectClass}`}
						>
							{data.regions
								.filter((region) => region.buildAvailable)
								.map((region) => (
									<option key={region.regionId} value={region.regionId}>
										{region.name}
									</option>
								))}
						</select>
					</div>
					<Field
						name="pool-name"
						label="Pool name"
						placeholder="East US builds"
					/>
					<Field
						name="pool-class"
						label="Worker class"
						placeholder="ephemeral-standard"
					/>
					<div>
						<Label
							htmlFor="pool-architecture"
							className="text-xs text-white/55"
						>
							Architecture
						</Label>
						<select
							id="pool-architecture"
							name="pool-architecture"
							className={`mt-1.5 ${selectClass}`}
						>
							<option value="amd64">amd64</option>
							<option value="arm64">arm64</option>
						</select>
					</div>
					<Field
						name="pool-version"
						label="BuildKit version"
						placeholder="0.25.1"
					/>
					<Field
						name="pool-min"
						label="Minimum capacity"
						type="number"
						defaultValue={0}
					/>
					<Field
						name="pool-total"
						label="Initial capacity"
						type="number"
						defaultValue={1}
					/>
					<Field
						name="pool-max"
						label="Maximum capacity"
						type="number"
						defaultValue={10}
					/>
					<Field
						name="pool-cache"
						label="Cache namespace"
						placeholder="deploytide-east-us"
					/>
					<div className="sm:col-span-2">
						<Field
							name="pool-endpoint"
							label="Internal endpoint (write only)"
							placeholder="https://build.internal"
							required={false}
						/>
					</div>
				</ActionForm>
			);
		}
		if (section === "runtime-clusters") {
			return (
				<div className="grid gap-4 xl:grid-cols-2">
					<ActionForm
						title="Create runtime cluster"
						detail="Internal endpoints are write-only. Certificate material is resolved from an opaque enrollment ID."
						submitLabel="Create cluster"
						busy={createRuntimeCluster.isPending}
						onSubmit={(form) =>
							mutate(
								createRuntimeCluster.mutateAsync({
									infrastructureProviderId: textValue(form, "cluster-provider"),
									regionId: textValue(form, "cluster-region"),
									name: textValue(form, "cluster-name"),
									runtimeAdapter: textValue(form, "cluster-adapter"),
									endpointReference: textValue(form, "cluster-endpoint"),
									certificateEnrollmentId: textValue(
										form,
										"cluster-enrollment",
									),
									controllerIdentity: textValue(form, "cluster-identity"),
									totalCpuMillis: numberValue(form, "cluster-cpu"),
									totalMemoryMb: numberValue(form, "cluster-memory"),
									controllerVersion: textValue(
										form,
										"cluster-controller-version",
									),
									version: textValue(form, "cluster-version"),
								}),
								"Runtime cluster created",
							)
						}
					>
						<div>
							<Label
								htmlFor="cluster-provider"
								className="text-xs text-white/55"
							>
								Provider
							</Label>
							<select
								id="cluster-provider"
								name="cluster-provider"
								required
								className={`mt-1.5 ${selectClass}`}
							>
								{data.providers.map((provider) => (
									<option
										key={provider.infrastructureProviderId}
										value={provider.infrastructureProviderId}
									>
										{provider.name}
									</option>
								))}
							</select>
						</div>
						<div>
							<Label htmlFor="cluster-region" className="text-xs text-white/55">
								Runtime region
							</Label>
							<select
								id="cluster-region"
								name="cluster-region"
								required
								className={`mt-1.5 ${selectClass}`}
							>
								{data.regions
									.filter((region) => region.runtimeAvailable)
									.map((region) => (
										<option key={region.regionId} value={region.regionId}>
											{region.name}
										</option>
									))}
							</select>
						</div>
						<Field
							name="cluster-name"
							label="Cluster name"
							placeholder="East US runtime"
						/>
						<Field
							name="cluster-adapter"
							label="Runtime adapter"
							defaultValue="docker-runtime"
						/>
						<Field
							name="cluster-endpoint"
							label="Internal endpoint (write only)"
							placeholder="https://runtime.internal"
						/>
						<Field
							name="cluster-enrollment"
							label="Certificate enrollment ID"
							placeholder="runtime-east-cert"
						/>
						<Field
							name="cluster-identity"
							label="Controller identity"
							placeholder="controller:east-us"
						/>
						<Field
							name="cluster-cpu"
							label="CPU millis"
							type="number"
							defaultValue={4000}
						/>
						<Field
							name="cluster-memory"
							label="Memory MB"
							type="number"
							defaultValue={8192}
						/>
						<Field
							name="cluster-controller-version"
							label="Controller version"
							placeholder="0.1.0"
						/>
						<Field
							name="cluster-version"
							label="Runtime version"
							placeholder="26.8"
						/>
					</ActionForm>
					<ActionForm
						title="Register runtime target"
						detail="Provider target mappings are accepted once and never returned to the browser."
						submitLabel="Register target"
						busy={createRuntimeTarget.isPending}
						onSubmit={(form) =>
							mutate(
								createRuntimeTarget.mutateAsync({
									runtimeClusterId: textValue(form, "target-cluster"),
									providerTargetReference: textValue(
										form,
										"target-provider-reference",
									),
									architecture: textValue(form, "target-architecture") as
										| "amd64"
										| "arm64",
									totalCpuMillis: numberValue(form, "target-cpu"),
									totalMemoryMb: numberValue(form, "target-memory"),
									version: textValue(form, "target-version"),
								}),
								"Runtime target registered",
							)
						}
					>
						<div>
							<Label htmlFor="target-cluster" className="text-xs text-white/55">
								Runtime cluster
							</Label>
							<select
								id="target-cluster"
								name="target-cluster"
								required
								className={`mt-1.5 ${selectClass}`}
							>
								{data.runtimeClusters.map((cluster) => (
									<option
										key={cluster.runtimeClusterId}
										value={cluster.runtimeClusterId}
									>
										{cluster.name}
									</option>
								))}
							</select>
						</div>
						<div>
							<Label
								htmlFor="target-architecture"
								className="text-xs text-white/55"
							>
								Architecture
							</Label>
							<select
								id="target-architecture"
								name="target-architecture"
								className={`mt-1.5 ${selectClass}`}
							>
								<option value="amd64">amd64</option>
								<option value="arm64">arm64</option>
							</select>
						</div>
						<Field
							name="target-provider-reference"
							label="Provider target mapping (write only)"
							placeholder="target-opaque-reference"
						/>
						<Field
							name="target-version"
							label="Target version"
							placeholder="26.8"
						/>
						<Field
							name="target-cpu"
							label="CPU millis"
							type="number"
							defaultValue={2000}
						/>
						<Field
							name="target-memory"
							label="Memory MB"
							type="number"
							defaultValue={4096}
						/>
					</ActionForm>
				</div>
			);
		}
		if (section === "incidents") {
			return (
				<ActionForm
					title="Open infrastructure incident"
					detail="Record a concise redacted operational summary; secrets and endpoint data are rejected."
					submitLabel="Open incident"
					busy={createIncident.isPending}
					onSubmit={(form) =>
						mutate(
							createIncident.mutateAsync({
								severity: textValue(form, "incident-severity") as
									| "info"
									| "warning"
									| "critical",
								title: textValue(form, "incident-title"),
								summary: textValue(form, "incident-summary"),
							}),
							"Incident opened",
						)
					}
				>
					<div>
						<Label
							htmlFor="incident-severity"
							className="text-xs text-white/55"
						>
							Severity
						</Label>
						<select
							id="incident-severity"
							name="incident-severity"
							className={`mt-1.5 ${selectClass}`}
						>
							<option value="info">Info</option>
							<option value="warning">Warning</option>
							<option value="critical">Critical</option>
						</select>
					</div>
					<Field
						name="incident-title"
						label="Title"
						placeholder="Regional capacity degraded"
					/>
					<div className="sm:col-span-2">
						<Field
							name="incident-summary"
							label="Redacted summary"
							placeholder="Scheduling is shifted to healthy regional capacity."
						/>
					</div>
				</ActionForm>
			);
		}
		if (section === "certificates") {
			return (
				<ActionForm
					title="Rotate controller certificate"
					detail="The enrollment ID resolves PEM and key material only on the server. The browser never receives certificate material."
					submitLabel="Register certificate"
					busy={registerCertificate.isPending}
					onSubmit={(form) =>
						mutate(
							registerCertificate.mutateAsync({
								runtimeClusterId: textValue(form, "certificate-cluster"),
								enrollmentId: textValue(form, "certificate-enrollment"),
							}),
							"Controller certificate registered",
						)
					}
				>
					<div>
						<Label
							htmlFor="certificate-cluster"
							className="text-xs text-white/55"
						>
							Runtime cluster
						</Label>
						<select
							id="certificate-cluster"
							name="certificate-cluster"
							required
							className={`mt-1.5 ${selectClass}`}
						>
							{data.runtimeClusters.map((cluster) => (
								<option
									key={cluster.runtimeClusterId}
									value={cluster.runtimeClusterId}
								>
									{cluster.name}
								</option>
							))}
						</select>
					</div>
					<Field
						name="certificate-enrollment"
						label="Opaque enrollment ID"
						placeholder="runtime-east-rotation"
					/>
				</ActionForm>
			);
		}
		return null;
	})();

	const body = (() => {
		if (section === "overview") {
			return (
				<div className="space-y-6">
					<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
						<Metric
							label="Providers"
							value={data.providers.length}
							detail={`${unhealthy} degraded or unavailable`}
							icon={CloudCog}
						/>
						<Metric
							label="Build headroom"
							value={`${Math.max(0, totalBuild - reservedBuild)}/${totalBuild}`}
							detail="Rootless ephemeral leases"
							icon={Cpu}
						/>
						<Metric
							label="Runtime CPU"
							value={`${Math.max(0, totalCpu - reservedCpu)}m`}
							detail={`${reservedCpu}m reserved`}
							icon={ServerCog}
						/>
						<Metric
							label="Active leases"
							value={data.activeLeases.length}
							detail="Fenced capacity reservations"
							icon={Workflow}
						/>
					</div>
					<div className="grid gap-5 xl:grid-cols-[1.3fr_.7fr]">
						<div className="rounded-2xl border border-white/10 bg-white/[.035] p-6">
							<div className="flex items-center justify-between">
								<div>
									<p className="text-sm font-semibold">Regional topology</p>
									<p className="text-xs text-white/40">
										Build and runtime availability by stable region.
									</p>
								</div>
								<Globe2 className="size-5 text-[#63d58b]" />
							</div>
							{data.regions.length === 0 ? (
								<div className="mt-5">
									<Empty
										title="No operator topology"
										detail="Bootstrap a local provider or register a production provider and two runtime regions."
									/>
								</div>
							) : (
								<div className="mt-6 space-y-3">
									{data.regions.map((region) => (
										<div
											key={region.regionId}
											className="grid gap-3 rounded-xl border border-white/8 bg-black/10 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-center"
										>
											<div>
												<p className="font-medium">{region.name}</p>
												<p className="mt-1 font-mono text-[11px] text-white/35">
													{region.code} ·{" "}
													{String(
														region.residencyMetadata.residency || "Unspecified",
													)}
												</p>
											</div>
											<div className="flex gap-2 text-[10px] uppercase tracking-[.14em] text-white/40">
												<span>{region.buildAvailable ? "Build" : "—"}</span>
												<span>{region.runtimeAvailable ? "Runtime" : "—"}</span>
											</div>
											<Status value={region.status} />
										</div>
									))}
								</div>
							)}
						</div>
						<div className="rounded-2xl border border-white/10 bg-[#18231c] p-6">
							<ShieldCheck className="size-5 text-[#63d58b]" />
							<p className="dt-display mt-8 text-3xl font-medium">
								Invisible by contract.
							</p>
							<p className="mt-3 text-sm leading-6 text-white/45">
								Provider credentials, machine identities and private endpoints
								never enter workspace DTOs. The operator audience is
								independently signed and audited.
							</p>
						</div>
					</div>
				</div>
			);
		}
		if (section === "providers") {
			return (
				<div className="grid gap-4 lg:grid-cols-2">
					{data.providers.length === 0 ? (
						<div className="lg:col-span-2">
							<Empty
								title="No provider registered"
								detail="Register LayerRail Compute or bootstrap the local contract adapter."
							/>
						</div>
					) : (
						data.providers.map((provider) => (
							<article
								key={provider.infrastructureProviderId}
								className="rounded-2xl border border-white/10 bg-white/[.035] p-6"
							>
								<div className="flex items-start justify-between gap-4">
									<span className="flex size-10 items-center justify-center rounded-xl bg-[#63d58b]/10">
										<Building2 className="size-5 text-[#63d58b]" />
									</span>
									<Status value={provider.health} />
								</div>
								<p className="mt-7 text-lg font-semibold">{provider.name}</p>
								<p className="mt-1 font-mono text-xs text-white/35">
									{provider.adapterType} · v{provider.version}
								</p>
								<div className="mt-5 flex flex-wrap gap-2">
									{provider.capabilities.map((capability) => (
										<span
											key={capability}
											className="rounded-md border border-white/8 px-2 py-1 text-[10px] text-white/45"
										>
											{capability}
										</span>
									))}
								</div>
								<div className="mt-6 flex items-center justify-between border-t border-white/8 pt-4">
									<span className="text-xs text-white/35">
										{provider.hasSecretReference
											? "External secret reference attached"
											: "No credential material"}
									</span>
									<Button
										size="sm"
										variant="outline"
										className="border-white/10 bg-transparent"
										isLoading={probe.isPending}
										onClick={() =>
											mutate(
												probe.mutateAsync({
													infrastructureProviderId:
														provider.infrastructureProviderId,
												}),
												"Provider probe completed",
											)
										}
									>
										<RefreshCcw className="size-3.5" /> Probe
									</Button>
								</div>
								{provider.adapterType === "layerrail-compute" && (
									<form
										className="mt-3 flex gap-2"
										onSubmit={async (event) => {
											event.preventDefault();
											const form = new FormData(event.currentTarget);
											await mutate(
												rotateProviderSecret.mutateAsync({
													infrastructureProviderId:
														provider.infrastructureProviderId,
													secretId: textValue(
														form,
														"provider-rotation-secret-id",
													),
												}),
												"Provider secret rotated; probe required",
											);
										}}
									>
										<Input
											name="provider-rotation-secret-id"
											required
											pattern="[a-z][a-z0-9_-]{2,63}"
											aria-label="New opaque provider secret ID"
											placeholder="New opaque secret ID"
											className={fieldClass}
										/>
										<Button
											type="submit"
											size="sm"
											variant="outline"
											isLoading={rotateProviderSecret.isPending}
											className="border-white/10 bg-transparent"
										>
											Rotate
										</Button>
									</form>
								)}
							</article>
						))
					)}
				</div>
			);
		}
		if (section === "regions") {
			return data.regions.length === 0 ? (
				<Empty
					title="No regions"
					detail="Operator-approved regional capacity appears here."
				/>
			) : (
				<div className="overflow-hidden rounded-2xl border border-white/10">
					<table className="w-full text-left text-sm">
						<thead className="bg-white/[.04] text-[10px] uppercase tracking-[.16em] text-white/35">
							<tr>
								<th className="p-4">Region</th>
								<th className="p-4">Planes</th>
								<th className="p-4">Weight</th>
								<th className="p-4">State</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/8">
							{data.regions.map((region) => (
								<tr key={region.regionId}>
									<td className="p-4">
										<p className="font-medium">{region.name}</p>
										<code className="text-xs text-white/35">{region.code}</code>
									</td>
									<td className="p-4 text-xs text-white/50">
										{[
											region.buildAvailable && "Build",
											region.runtimeAvailable && "Runtime",
										]
											.filter(Boolean)
											.join(" · ")}
									</td>
									<td className="p-4 text-xs text-white/50">
										route {region.routingWeight} / cost {region.costWeight}
									</td>
									<td className="p-4">
										<Status value={region.status} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		}
		if (section === "build-pools") {
			return data.buildPools.length === 0 ? (
				<Empty
					title="No build pools"
					detail="Dedicated rootless BuildKit capacity is required before builds can be scheduled."
				/>
			) : (
				<div className="grid gap-4 md:grid-cols-2">
					{data.buildPools.map((pool) => (
						<article
							key={pool.buildPoolId}
							className="rounded-2xl border border-white/10 bg-white/[.035] p-5"
						>
							<div className="flex items-center justify-between">
								<Cpu className="size-5 text-[#63d58b]" />
								<Status value={pool.drainState} />
							</div>
							<p className="mt-6 font-semibold">{pool.name}</p>
							<p className="mt-1 text-xs text-white/40">
								{pool.adapterType} · {pool.architecture} · {pool.workerClass}
							</p>
							<div className="mt-7 h-2 overflow-hidden rounded-full bg-white/5">
								<div
									className="h-full bg-[#63d58b]"
									style={{
										width: `${Math.min(
											100,
											(pool.reservedCapacity /
												Math.max(1, pool.totalCapacity)) *
												100,
										)}%`,
									}}
								/>
							</div>
							<div className="mt-3 flex justify-between text-xs text-white/35">
								<span>{pool.reservedCapacity} active</span>
								<span>{pool.totalCapacity} total</span>
							</div>
							<div className="mt-5 flex flex-col gap-3 border-t border-white/8 pt-4 sm:flex-row sm:items-center sm:justify-between">
								<p className="text-xs text-white/35">
									{pool.rootless
										? "Rootless ephemeral workers"
										: "Rejected mode"}
								</p>
								<div className="flex flex-wrap gap-2">
									{pool.drainState === "active" ? (
										<Button
											size="sm"
											variant="outline"
											className="border-amber-400/20 bg-amber-400/5 text-amber-100 hover:bg-amber-400/10"
											disabled={buildPoolLifecycleBusy}
											isLoading={drainBuildPool.isPending}
											onClick={() =>
												mutate(
													drainBuildPool.mutateAsync({
														buildPoolId: pool.buildPoolId,
													}),
													"Build pool drain requested",
												)
											}
										>
											Drain
										</Button>
									) : (
										<>
											<Button
												size="sm"
												variant="outline"
												className="border-white/10 bg-transparent"
												disabled={buildPoolLifecycleBusy}
												isLoading={reconcileBuildPoolDrain.isPending}
												onClick={() =>
													mutate(
														reconcileBuildPoolDrain.mutateAsync({
															buildPoolId: pool.buildPoolId,
														}),
														"Build pool drain reconciled",
													)
												}
											>
												<RefreshCcw className="size-3.5" /> Reconcile
											</Button>
											<Button
												size="sm"
												variant="outline"
												className="border-white/10 bg-transparent"
												disabled={buildPoolLifecycleBusy}
												isLoading={restoreBuildPool.isPending}
												onClick={() =>
													mutate(
														restoreBuildPool.mutateAsync({
															buildPoolId: pool.buildPoolId,
														}),
														"Build pool restored",
													)
												}
											>
												<ArchiveRestore className="size-3.5" /> Restore
											</Button>
										</>
									)}
								</div>
							</div>
						</article>
					))}
				</div>
			);
		}
		if (section === "runtime-clusters") {
			return data.runtimeClusters.length === 0 ? (
				<Empty
					title="No runtime clusters"
					detail="Operator-managed regional clusters appear after provisioning."
				/>
			) : (
				<div className="space-y-4">
					{data.runtimeClusters.map((cluster) => (
						<article
							key={cluster.runtimeClusterId}
							className="rounded-2xl border border-white/10 bg-white/[.035] p-6"
						>
							<div className="grid gap-5 md:grid-cols-[1fr_auto_auto] md:items-center">
								<div>
									<div className="flex items-center gap-3">
										<ServerCog className="size-5 text-[#63d58b]" />
										<p className="font-semibold">{cluster.name}</p>
									</div>
									<p className="mt-2 font-mono text-xs text-white/35">
										{cluster.runtimeAdapter} · controller{" "}
										{cluster.controllerVersion}
									</p>
								</div>
								<div className="flex gap-2">
									<Status value={cluster.health} />
									<Status value={cluster.drainState} />
								</div>
								<div className="flex gap-2">
									<Button
										size="sm"
										variant="outline"
										className="border-white/10 bg-transparent"
										disabled={cluster.drainState !== "active"}
										onClick={() =>
											mutate(
												drain.mutateAsync({
													runtimeClusterId: cluster.runtimeClusterId,
												}),
												"Cluster drain requested",
											)
										}
									>
										Drain
									</Button>
									<Button
										size="sm"
										variant="outline"
										className="border-white/10 bg-transparent"
										disabled={cluster.drainState === "active"}
										onClick={() =>
											mutate(
												restore.mutateAsync({
													runtimeClusterId: cluster.runtimeClusterId,
												}),
												"Cluster restored",
											)
										}
									>
										Restore
									</Button>
								</div>
							</div>
							<div className="mt-5 grid gap-3 sm:grid-cols-3">
								<div className="rounded-xl bg-black/10 p-3">
									<p className="text-[10px] uppercase tracking-[.15em] text-white/35">
										CPU
									</p>
									<p className="mt-2 text-sm font-medium">
										{cluster.reservedCpuMillis}m / {cluster.totalCpuMillis}m
									</p>
								</div>
								<div className="rounded-xl bg-black/10 p-3">
									<p className="text-[10px] uppercase tracking-[.15em] text-white/35">
										Memory
									</p>
									<p className="mt-2 text-sm font-medium">
										{cluster.reservedMemoryMb} / {cluster.totalMemoryMb} MB
									</p>
								</div>
								<div className="rounded-xl bg-black/10 p-3">
									<p className="text-[10px] uppercase tracking-[.15em] text-white/35">
										Targets
									</p>
									<p className="mt-2 text-sm font-medium">
										{cluster.targetCount}
									</p>
								</div>
							</div>
						</article>
					))}
				</div>
			);
		}
		if (section === "capacity") {
			return (
				<div className="space-y-5">
					<div className="flex justify-end">
						<Button
							variant="outline"
							className="border-white/10 bg-transparent"
							isLoading={reconcile.isPending}
							onClick={() =>
								mutate(
									reconcile.mutateAsync(),
									"Lease reconciliation completed",
								)
							}
						>
							<RefreshCcw className="size-4" /> Reconcile expired work
						</Button>
					</div>
					{data.activeLeases.length === 0 ? (
						<Empty
							title="No active leases"
							detail="Build and runtime reservations appear here as redacted capacity summaries."
						/>
					) : (
						<div className="overflow-hidden rounded-2xl border border-white/10">
							<table className="w-full text-left text-sm">
								<thead className="bg-white/[.04] text-[10px] uppercase tracking-[.16em] text-white/35">
									<tr>
										<th className="p-4">Plane</th>
										<th className="p-4">Scope</th>
										<th className="p-4">Reservation</th>
										<th className="p-4">Expires</th>
										<th className="p-4">State</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-white/8">
									{data.activeLeases.map((lease, index) => (
										<tr
											key={`${lease.kind}-${new Date(lease.expiresAt).toISOString()}-${index}`}
										>
											<td className="p-4 capitalize">{lease.kind}</td>
											<td className="p-4 capitalize text-white/50">
												{lease.leaseScope}
											</td>
											<td className="p-4 text-xs text-white/50">
												{lease.kind === "build"
													? `${lease.reservedCapacity} slot`
													: `${lease.reservedCpuMillis}m / ${lease.reservedMemoryMb} MB`}
											</td>
											<td className="p-4 text-xs text-white/40">
												{new Date(lease.expiresAt).toLocaleString()}
											</td>
											<td className="p-4">
												<Status value={lease.state} />
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			);
		}
		if (section === "versions") {
			return (
				<div className="grid gap-4 md:grid-cols-2">
					{[
						...data.providers.map((provider) => ({
							id: provider.infrastructureProviderId,
							name: provider.name,
							detail: provider.adapterType,
							version: provider.version,
							state: provider.health,
						})),
						...data.runtimeClusters.map((cluster) => ({
							id: cluster.runtimeClusterId,
							name: cluster.name,
							detail: "Runtime controller",
							version: cluster.controllerVersion,
							state: cluster.health,
						})),
						...data.buildPools.map((pool) => ({
							id: pool.buildPoolId,
							name: pool.name,
							detail: pool.adapterType,
							version: pool.version,
							state: pool.health,
						})),
					].map((item) => (
						<div
							key={item.id}
							className="rounded-2xl border border-white/10 bg-white/[.035] p-5"
						>
							<div className="flex items-center justify-between">
								<GitCommitHorizontal className="size-4 text-[#63d58b]" />
								<Status value={item.state} />
							</div>
							<p className="mt-6 font-semibold">{item.name}</p>
							<p className="mt-1 text-xs text-white/40">{item.detail}</p>
							<code className="mt-5 block rounded-lg bg-black/20 px-3 py-2 text-xs text-white/60">
								{item.version}
							</code>
						</div>
					))}
				</div>
			);
		}
		if (section === "drains") {
			const draining = data.runtimeClusters.filter(
				(cluster) => cluster.drainState !== "active",
			);
			return draining.length === 0 ? (
				<Empty
					title="No drains in progress"
					detail="Draining clusters stop new placement and retain serving releases until relocation or internal pinning resolves."
				/>
			) : (
				<div className="space-y-4">
					{draining.map((cluster) => (
						<div
							key={cluster.runtimeClusterId}
							className="rounded-2xl border border-amber-400/15 bg-amber-400/[.04] p-6"
						>
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<ArchiveRestore className="size-5 text-amber-200" />
									<p className="font-semibold">{cluster.name}</p>
								</div>
								<Status value={cluster.drainState} />
							</div>
							<p className="mt-3 text-sm text-white/45">
								New placement is blocked. Existing live traffic remains until
								movable releases are reconciled.
							</p>
							<div className="mt-5 flex gap-2">
								<Button
									size="sm"
									variant="outline"
									className="border-white/10 bg-transparent"
									isLoading={reconcileDrain.isPending}
									onClick={() =>
										mutate(
											reconcileDrain.mutateAsync({
												runtimeClusterId: cluster.runtimeClusterId,
											}),
											"Drain reconciled",
										)
									}
								>
									Reconcile
								</Button>
								<Button
									size="sm"
									variant="outline"
									className="border-white/10 bg-transparent"
									isLoading={restore.isPending}
									onClick={() =>
										mutate(
											restore.mutateAsync({
												runtimeClusterId: cluster.runtimeClusterId,
											}),
											"Cluster restored",
										)
									}
								>
									Restore
								</Button>
							</div>
						</div>
					))}
				</div>
			);
		}
		if (section === "incidents") {
			return data.incidents.length === 0 ? (
				<Empty
					title="No infrastructure incidents"
					detail="Provider, pool, controller and regional incidents appear in this global ledger."
				/>
			) : (
				<div className="space-y-3">
					{data.incidents.map((incident) => (
						<article
							key={incident.infrastructureIncidentId}
							className="rounded-2xl border border-white/10 bg-white/[.035] p-5"
						>
							<div className="flex items-start justify-between gap-4">
								<div>
									<div className="flex items-center gap-3">
										<TriangleAlert
											className={cn(
												"size-4",
												incident.severity === "critical"
													? "text-red-400"
													: "text-amber-300",
											)}
										/>
										<p className="font-semibold">{incident.title}</p>
									</div>
									<p className="mt-2 text-sm leading-6 text-white/45">
										{incident.summary}
									</p>
								</div>
								<Status value={incident.status} />
							</div>
							{incident.status !== "resolved" && (
								<Button
									size="sm"
									variant="outline"
									className="mt-5 border-white/10 bg-transparent"
									onClick={() =>
										mutate(
											resolveIncident.mutateAsync({
												infrastructureIncidentId:
													incident.infrastructureIncidentId,
											}),
											"Incident resolved",
										)
									}
								>
									Resolve
								</Button>
							)}
						</article>
					))}
				</div>
			);
		}
		if (section === "certificates") {
			return data.controllerCertificates.length === 0 ? (
				<Empty
					title="No controller certificates"
					detail="Register an opaque enrollment after a runtime cluster exists."
				/>
			) : (
				<div className="grid gap-4 lg:grid-cols-2">
					{data.controllerCertificates.map((certificate) => (
						<article
							key={certificate.controllerCertificateId}
							className="rounded-2xl border border-white/10 bg-white/[.035] p-5"
						>
							<div className="flex items-start justify-between">
								<KeyRound className="size-5 text-[#63d58b]" />
								<Status value={certificate.status} />
							</div>
							<p className="mt-6 text-sm font-semibold">
								Controller certificate
							</p>
							<p className="mt-2 text-xs text-white/40">
								Valid {new Date(certificate.notBefore).toLocaleDateString()} —{" "}
								{new Date(certificate.notAfter).toLocaleDateString()}
							</p>
							{certificate.status !== "revoked" && (
								<form
									className="mt-5 flex gap-2 border-t border-white/8 pt-4"
									onSubmit={async (event) => {
										event.preventDefault();
										const form = new FormData(event.currentTarget);
										await mutate(
											revokeCertificate.mutateAsync({
												controllerCertificateId:
													certificate.controllerCertificateId,
												reason: textValue(form, "revocation-reason"),
											}),
											"Certificate revoked",
										);
									}}
								>
									<Input
										name="revocation-reason"
										aria-label="Revocation reason"
										required
										minLength={3}
										maxLength={300}
										placeholder="Reason for revocation"
										className={fieldClass}
									/>
									<Button
										type="submit"
										size="sm"
										variant="outline"
										isLoading={revokeCertificate.isPending}
										className="border-red-400/20 bg-red-400/5 text-red-200"
									>
										Revoke
									</Button>
								</form>
							)}
						</article>
					))}
				</div>
			);
		}
		const ambiguous = data.legacyInputs.filter(
			(entry) => entry.disposition === "ambiguous",
		).length;
		return (
			<div className="space-y-5">
				<div className="rounded-2xl border border-white/10 bg-white/[.035] p-6">
					<DatabaseZap className="size-5 text-[#63d58b]" />
					<h2 className="dt-display mt-7 text-3xl font-medium">
						Explicit migration intake
					</h2>
					<p className="mt-3 max-w-2xl text-sm leading-6 text-white/45">
						Existing server rows are inputs, not adopted infrastructure.
						Platform ownership must be reviewed before import; customer-owned or
						ambiguous machines are exported instead.
					</p>
					<p className="mt-6 text-sm">
						<span className="text-3xl font-semibold">{ambiguous}</span>{" "}
						<span className="text-white/35">awaiting classification</span>
					</p>
				</div>
				{data.legacyInputs.length === 0 ? (
					<Empty
						title="No legacy inputs"
						detail="The inventory is empty or has not been seeded from retained server rows."
					/>
				) : (
					<div className="space-y-4">
						{data.legacyInputs.map((entry) => (
							<article
								key={entry.legacyInfrastructureInputId}
								className="rounded-xl border border-white/10 bg-black/10 p-4"
							>
								<div className="flex items-start justify-between gap-4">
									<div>
										<p className="font-mono text-xs">
											Intake {entry.legacyInfrastructureInputId.slice(0, 12)}
										</p>
										<p className="mt-1 text-xs text-white/35">
											{entry.hasReviewNote ? "Reviewed" : "No review note"} ·{" "}
											{entry.hasExport ? "exported" : "not exported"}
										</p>
									</div>
									<Status value={entry.disposition} />
								</div>
								<form
									className="mt-4 grid gap-2 border-t border-white/8 pt-4 sm:grid-cols-[160px_1fr_auto]"
									onSubmit={async (event) => {
										event.preventDefault();
										const form = new FormData(event.currentTarget);
										await mutate(
											classifyLegacy.mutateAsync({
												legacyInfrastructureInputId:
													entry.legacyInfrastructureInputId,
												disposition: textValue(form, "legacy-disposition") as
													| "platform_owned"
													| "customer_owned"
													| "rejected",
												reviewNote: textValue(form, "legacy-review-note"),
											}),
											"Legacy input classified",
										);
									}}
								>
									<select
										name="legacy-disposition"
										aria-label="Disposition"
										className={selectClass}
									>
										<option value="platform_owned">Platform owned</option>
										<option value="customer_owned">Customer owned</option>
										<option value="rejected">Rejected</option>
									</select>
									<Input
										name="legacy-review-note"
										required
										minLength={3}
										maxLength={500}
										placeholder="Evidence-based review note"
										className={fieldClass}
									/>
									<Button
										type="submit"
										size="sm"
										variant="outline"
										isLoading={classifyLegacy.isPending}
										className="border-white/10 bg-transparent"
									>
										Classify
									</Button>
								</form>
								<div className="mt-3 flex flex-wrap gap-2">
									<Button
										size="sm"
										variant="outline"
										className="border-white/10 bg-transparent"
										isLoading={exportLegacy.isPending}
										onClick={() =>
											mutate(
												exportLegacy.mutateAsync({
													legacyInfrastructureInputId:
														entry.legacyInfrastructureInputId,
												}),
												"Legacy input exported",
											)
										}
									>
										Export redacted record
									</Button>
									{entry.disposition === "imported" && (
										<Button
											size="sm"
											variant="outline"
											className="border-white/10 bg-transparent"
											isLoading={retireBootstrap.isPending}
											onClick={() =>
												mutate(
													retireBootstrap.mutateAsync({
														legacyInfrastructureInputId:
															entry.legacyInfrastructureInputId,
													}),
													"Bootstrap access retired",
												)
											}
										>
											Retire bootstrap access
										</Button>
									)}
								</div>
								{entry.disposition === "platform_owned" && (
									<form
										className="mt-3 grid gap-2 sm:grid-cols-5"
										onSubmit={async (event) => {
											event.preventDefault();
											const form = new FormData(event.currentTarget);
											await mutate(
												importLegacy.mutateAsync({
													legacyInfrastructureInputId:
														entry.legacyInfrastructureInputId,
													runtimeClusterId: textValue(form, "legacy-cluster"),
													architecture: textValue(
														form,
														"legacy-architecture",
													) as "amd64" | "arm64",
													totalCpuMillis: numberValue(form, "legacy-cpu"),
													totalMemoryMb: numberValue(form, "legacy-memory"),
												}),
												"Legacy input imported",
											);
										}}
									>
										<select
											name="legacy-cluster"
											aria-label="Runtime cluster"
											className={selectClass}
										>
											{data.runtimeClusters.map((cluster) => (
												<option
													key={cluster.runtimeClusterId}
													value={cluster.runtimeClusterId}
												>
													{cluster.name}
												</option>
											))}
										</select>
										<select
											name="legacy-architecture"
											aria-label="Architecture"
											className={selectClass}
										>
											<option value="amd64">amd64</option>
											<option value="arm64">arm64</option>
										</select>
										<Input
											name="legacy-cpu"
											type="number"
											required
											defaultValue={1000}
											aria-label="CPU millis"
											className={fieldClass}
										/>
										<Input
											name="legacy-memory"
											type="number"
											required
											defaultValue={1024}
											aria-label="Memory MB"
											className={fieldClass}
										/>
										<Button
											type="submit"
											size="sm"
											isLoading={importLegacy.isPending}
											className="bg-[#63d58b] text-[#0a120d]"
										>
											Import
										</Button>
									</form>
								)}
							</article>
						))}
					</div>
				)}
			</div>
		);
	})();

	return (
		<div className="min-h-screen bg-[#101512] text-[#edf3ee]">
			<header className="sticky top-0 z-30 border-b border-white/8 bg-[#101512]/90 backdrop-blur-xl">
				<div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between px-5 sm:px-8">
					<Link
						href="/admin/infrastructure"
						className="flex items-center gap-3"
					>
						<span className="flex size-9 items-center justify-center rounded-xl bg-[#63d58b] text-[#0a120d]">
							<CloudCog className="size-5" />
						</span>
						<div>
							<p className="text-sm font-semibold">DeployTide Operator</p>
							<p className="text-[10px] uppercase tracking-[.16em] text-white/35">
								Infrastructure plane
							</p>
						</div>
					</Link>
					<div className="flex items-center gap-3">
						<span className="hidden text-xs text-white/35 sm:inline">
							{operatorEmail}
						</span>
						<Button
							variant="outline"
							size="sm"
							className="border-white/10 bg-transparent"
							onClick={async () => {
								try {
									const csrf = await fetch("/api/operator/csrf", {
										cache: "no-store",
										credentials: "same-origin",
									}).then(async (response) => {
										if (!response.ok)
											throw new Error("Operator session is unavailable");
										return ((await response.json()) as { csrfToken: string })
											.csrfToken;
									});
									const response = await fetch("/api/operator/session", {
										method: "DELETE",
										credentials: "same-origin",
										headers: {
											"Content-Type": "application/json",
											"X-DeployTide-Operator-CSRF": csrf,
										},
										body: "{}",
									});
									if (!response.ok)
										throw new Error("Operator session could not be locked");
									clearOperatorApiSession();
									await router.push("/admin/login");
								} catch (error) {
									toast.error(
										error instanceof Error
											? error.message
											: "Operator session could not be locked",
									);
								}
							}}
						>
							<KeyRound className="size-3.5" /> Lock
						</Button>
					</div>
				</div>
			</header>
			<div className="mx-auto grid max-w-[1500px] gap-8 px-5 py-8 lg:grid-cols-[220px_minmax(0,1fr)] sm:px-8">
				<aside>
					<nav
						className="sticky top-24 space-y-1"
						aria-label="Infrastructure administration"
					>
						{navigation.map((item) => {
							const href =
								item.section === "overview"
									? "/admin/infrastructure"
									: `/admin/infrastructure/${item.section}`;
							return (
								<Link
									key={item.section}
									href={href}
									className={cn(
										"flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
										section === item.section
											? "bg-[#63d58b] text-[#0a120d]"
											: "text-white/45 hover:bg-white/[.04] hover:text-white",
									)}
								>
									<item.icon className="size-4" />
									{item.label}
									<ChevronRight className="ml-auto size-3.5 opacity-40" />
								</Link>
							);
						})}
					</nav>
				</aside>
				<main className="min-w-0">
					<div className="mb-8 flex flex-col gap-5 border-b border-white/8 pb-8 sm:flex-row sm:items-end sm:justify-between">
						<div>
							<p className="text-[10px] font-bold uppercase tracking-[.22em] text-[#63d58b]">
								Global operator scope
							</p>
							<h1 className="dt-display mt-3 text-5xl font-medium capitalize tracking-[-.045em] sm:text-6xl">
								{section.replaceAll("-", " ")}
							</h1>
							<p className="mt-3 max-w-2xl text-sm leading-6 text-white/40">
								Provider-neutral capacity, fenced work and regional runtime
								state. Never workspace-owned.
							</p>
						</div>
						{process.env.NODE_ENV !== "production" &&
							data.providers.length === 0 && (
								<Button
									className="bg-[#63d58b] text-[#0a120d] hover:bg-[#78e49c]"
									isLoading={bootstrap.isPending}
									onClick={() =>
										mutate(
											bootstrap.mutateAsync({
												name: "DeployTide Local",
												regions: [
													{
														code: "east-us",
														name: "East US",
														residency: "United States",
													},
													{
														code: "uk-south",
														name: "UK South",
														residency: "United Kingdom",
													},
												],
												controllerCertificateEnrollmentId: "local-controller",
												controllerVersion: "0.1.0",
											}),
											"Operator topology provisioned",
										)
									}
								>
									<CloudCog className="size-4" /> Bootstrap local topology
								</Button>
							)}
					</div>
					{lifecycleAction && <div className="mb-6">{lifecycleAction}</div>}
					{body}
				</main>
			</div>
		</div>
	);
};
