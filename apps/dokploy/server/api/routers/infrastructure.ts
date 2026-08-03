import {
	bootstrapLocalOperatorTopology,
	classifyLegacyInfrastructureInput,
	createBuildPool,
	createInfrastructureIncident,
	createInfrastructureProvider,
	createRegion,
	createRuntimeCluster,
	createRuntimeTarget,
	exportLegacyInfrastructureInput,
	importApprovedLegacyInfrastructureInput,
	listOperatorInfrastructureOverview,
	probeInfrastructureProvider,
	reconcileBuildPoolDrain,
	reconcileExpiredCapacityLeases,
	reconcileExpiredOperationClaims,
	reconcileRuntimeClusterDrain,
	recordOperatorAudit,
	registerControllerCertificate,
	requestBuildPoolDrain,
	requestRuntimeClusterDrain,
	resolveInfrastructureIncident,
	resolveLegacyInfrastructureServerId,
	restoreBuildPool,
	restoreRuntimeCluster,
	retireLegacyBootstrapAccess,
	revokeControllerCertificate,
	rotateInfrastructureProviderSecret,
} from "@dokploy/server";
import { z } from "zod";
import { createTRPCRouter, superadminProcedure } from "../trpc";

const architecture = z.enum(["amd64", "arm64"]);
const secretId = z
	.string()
	.regex(
		/^[a-z][a-z0-9_-]{2,63}$/,
		"Use a configured opaque operator secret ID",
	)
	.nullable()
	.optional();
const safeOperatorText = (minimum: number, maximum: number) =>
	z
		.string()
		.trim()
		.min(minimum)
		.max(maximum)
		.refine(
			(value) =>
				!/(?:https?|file|env|ssh|docker):\/\/|-----BEGIN |bearer\s+|(?:secret|token|password|private.?key|credential|endpoint)\s*[:=]/i.test(
					value,
				),
			"Enter a redacted summary without endpoints or credentials",
		);
const operatorMetadata = (ctx: {
	user: { id: string; email: string };
	req: { headers: Record<string, string | string[] | undefined> };
}) => ({
	actorUserId: ctx.user.id,
	actorEmail: ctx.user.email,
	requestId:
		(typeof ctx.req.headers["x-request-id"] === "string"
			? ctx.req.headers["x-request-id"]
			: undefined) ?? null,
});

export const infrastructureRouter = createTRPCRouter({
	overview: superadminProcedure.query(() =>
		listOperatorInfrastructureOverview(),
	),

	bootstrapLocal: superadminProcedure
		.input(
			z.object({
				name: z.string().trim().min(2).max(80),
				regions: z
					.array(
						z.object({
							code: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
							name: z.string().trim().min(2).max(80),
							residency: z.string().trim().min(2).max(80),
						}),
					)
					.length(2),
				controllerCertificateEnrollmentId: z
					.string()
					.regex(/^[a-z][a-z0-9_-]{2,63}$/),
				controllerVersion: z.string().min(1).max(80),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await bootstrapLocalOperatorTopology(
				{
					...input,
					regions: input.regions as [
						{ code: string; name: string; residency: string },
						{ code: string; name: string; residency: string },
					],
					actorId: ctx.user.id,
				},
				{
					...operatorMetadata(ctx),
					action: "bootstrap",
					resourceType: "infrastructureTopology",
				},
			);
			return listOperatorInfrastructureOverview();
		}),

	createProvider: superadminProcedure
		.input(
			z.object({
				name: z.string().trim().min(2).max(80),
				adapterType: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
				endpointReference: z.string().min(1).max(500),
				secretId,
				capabilities: z.array(z.string().min(1).max(120)).max(64),
				version: z.string().min(1).max(80),
			}),
		)
		.mutation(({ ctx, input }) =>
			createInfrastructureProvider(input, {
				...operatorMetadata(ctx),
				action: "create",
				resourceType: "infrastructureProvider",
			}),
		),

	probeProvider: superadminProcedure
		.input(z.object({ infrastructureProviderId: z.string().min(1) }))
		.mutation(({ ctx, input }) =>
			probeInfrastructureProvider(input.infrastructureProviderId, undefined, {
				...operatorMetadata(ctx),
				action: "probe",
				resourceType: "infrastructureProvider",
				resourceId: input.infrastructureProviderId,
			}),
		),

	rotateProviderSecret: superadminProcedure
		.input(
			z.object({
				infrastructureProviderId: z.string().min(1),
				secretId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
			}),
		)
		.mutation(({ ctx, input }) =>
			rotateInfrastructureProviderSecret(input, {
				...operatorMetadata(ctx),
				action: "rotate-secret",
				resourceType: "infrastructureProvider",
				resourceId: input.infrastructureProviderId,
			}),
		),

	createRegion: superadminProcedure
		.input(
			z.object({
				infrastructureProviderId: z.string().min(1),
				code: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
				name: z.string().trim().min(2).max(80),
				providerRegionReference: z.string().min(1).max(160),
				buildAvailable: z.boolean(),
				runtimeAvailable: z.boolean(),
				residencyMetadata: z
					.record(z.string(), z.union([z.string(), z.boolean()]))
					.optional(),
				routingWeight: z.number().int().min(1).max(10_000).optional(),
				costWeight: z.number().int().min(1).max(10_000).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const region = await createRegion(input, {
				...operatorMetadata(ctx),
				action: "create",
				resourceType: "region",
			});
			return {
				regionId: region.regionId,
				infrastructureProviderId: region.infrastructureProviderId,
				code: region.code,
				name: region.name,
				buildAvailable: region.buildAvailable,
				runtimeAvailable: region.runtimeAvailable,
				status: region.status,
				routingWeight: region.routingWeight,
				costWeight: region.costWeight,
			};
		}),

	createBuildPool: superadminProcedure
		.input(
			z.object({
				infrastructureProviderId: z.string().min(1),
				regionId: z.string().min(1),
				name: z.string().trim().min(2).max(100),
				adapterType: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
				architecture,
				workerClass: z.string().min(1).max(80),
				minCapacity: z.number().int().nonnegative(),
				maxCapacity: z.number().int().positive(),
				totalCapacity: z.number().int().positive(),
				cacheNamespace: z.string().min(1).max(160),
				endpointReference: z.string().max(500).nullable().optional(),
				autoscalingPolicy: z.record(z.string(), z.unknown()).optional(),
				version: z.string().min(1).max(80),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const pool = await createBuildPool(input, {
				...operatorMetadata(ctx),
				action: "create",
				resourceType: "buildPool",
			});
			return {
				buildPoolId: pool.buildPoolId,
				infrastructureProviderId: pool.infrastructureProviderId,
				regionId: pool.regionId,
				name: pool.name,
				adapterType: pool.adapterType,
				architecture: pool.architecture,
				workerClass: pool.workerClass,
				rootless: pool.rootless,
				minCapacity: pool.minCapacity,
				maxCapacity: pool.maxCapacity,
				totalCapacity: pool.totalCapacity,
				reservedCapacity: pool.reservedCapacity,
				health: pool.health,
				drainState: pool.drainState,
				version: pool.version,
			};
		}),

	drainBuildPool: superadminProcedure
		.input(z.object({ buildPoolId: z.string().min(1).max(192) }))
		.mutation(({ ctx, input }) =>
			requestBuildPoolDrain(input.buildPoolId, {
				...operatorMetadata(ctx),
				action: "drain",
				resourceType: "buildPool",
				resourceId: input.buildPoolId,
			}),
		),

	reconcileBuildPoolDrain: superadminProcedure
		.input(z.object({ buildPoolId: z.string().min(1).max(192) }))
		.mutation(({ ctx, input }) =>
			reconcileBuildPoolDrain(input.buildPoolId, {
				...operatorMetadata(ctx),
				action: "reconcile",
				resourceType: "buildPool",
				resourceId: input.buildPoolId,
			}),
		),

	restoreBuildPool: superadminProcedure
		.input(z.object({ buildPoolId: z.string().min(1).max(192) }))
		.mutation(({ ctx, input }) =>
			restoreBuildPool(input.buildPoolId, {
				...operatorMetadata(ctx),
				action: "restore",
				resourceType: "buildPool",
				resourceId: input.buildPoolId,
			}),
		),

	createRuntimeCluster: superadminProcedure
		.input(
			z.object({
				infrastructureProviderId: z.string().min(1),
				regionId: z.string().min(1),
				name: z.string().trim().min(2).max(100),
				runtimeAdapter: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
				endpointReference: z.string().min(1).max(500),
				certificateEnrollmentId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
				controllerIdentity: z.string().min(1).max(192),
				totalCpuMillis: z.number().int().positive(),
				totalMemoryMb: z.number().int().positive(),
				controllerVersion: z.string().min(1).max(80),
				version: z.string().min(1).max(80),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const cluster = await createRuntimeCluster(input, {
				...operatorMetadata(ctx),
				action: "create",
				resourceType: "runtimeCluster",
			});
			return {
				runtimeClusterId: cluster.runtimeClusterId,
				infrastructureProviderId: cluster.infrastructureProviderId,
				regionId: cluster.regionId,
				name: cluster.name,
				runtimeAdapter: cluster.runtimeAdapter,
				totalCpuMillis: cluster.totalCpuMillis,
				reservedCpuMillis: cluster.reservedCpuMillis,
				totalMemoryMb: cluster.totalMemoryMb,
				reservedMemoryMb: cluster.reservedMemoryMb,
				health: cluster.health,
				drainState: cluster.drainState,
				controllerVersion: cluster.controllerVersion,
				version: cluster.version,
			};
		}),

	createRuntimeTarget: superadminProcedure
		.input(
			z.object({
				runtimeClusterId: z.string().min(1),
				providerTargetReference: z.string().min(1).max(500),
				architecture,
				totalCpuMillis: z.number().int().positive(),
				totalMemoryMb: z.number().int().positive(),
				placementLabels: z.record(z.string(), z.string()).optional(),
				version: z.string().min(1).max(80),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const target = await createRuntimeTarget(input, {
				...operatorMetadata(ctx),
				action: "create",
				resourceType: "runtimeTarget",
			});
			return {
				runtimeClusterId: target.runtimeClusterId,
				created: true,
				architecture: target.architecture,
				totalCpuMillis: target.totalCpuMillis,
				reservedCpuMillis: target.reservedCpuMillis,
				totalMemoryMb: target.totalMemoryMb,
				reservedMemoryMb: target.reservedMemoryMb,
				health: target.health,
				drainState: target.drainState,
				version: target.version,
			};
		}),

	drainCluster: superadminProcedure
		.input(z.object({ runtimeClusterId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const cluster = await requestRuntimeClusterDrain(input.runtimeClusterId);
			await recordOperatorAudit({
				...operatorMetadata(ctx),
				action: "drain",
				resourceType: "runtimeCluster",
				resourceId: input.runtimeClusterId,
			});
			return {
				runtimeClusterId: cluster.runtimeClusterId,
				health: cluster.health,
				drainState: cluster.drainState,
			};
		}),

	reconcileDrain: superadminProcedure
		.input(z.object({ runtimeClusterId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const result = await reconcileRuntimeClusterDrain(input.runtimeClusterId);
			await recordOperatorAudit({
				...operatorMetadata(ctx),
				action: "reconcile",
				resourceType: "runtimeCluster",
				resourceId: input.runtimeClusterId,
				metadata: {
					complete: result.complete,
					activeLeases: result.activeLeaseIds.length,
					blockedReleases: result.failedReleaseIds.length,
				},
			});
			return {
				complete: result.complete,
				activeLeases: result.activeLeaseIds.length,
				blockedReleases: result.failedReleaseIds.length,
				pinnedReleases: result.pinnedReleaseIds.length,
				relocatedReleases: result.relocatedReleaseIds.length,
			};
		}),

	restoreCluster: superadminProcedure
		.input(z.object({ runtimeClusterId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const cluster = await restoreRuntimeCluster(input.runtimeClusterId);
			await recordOperatorAudit({
				...operatorMetadata(ctx),
				action: "restore",
				resourceType: "runtimeCluster",
				resourceId: input.runtimeClusterId,
			});
			return {
				runtimeClusterId: cluster.runtimeClusterId,
				health: cluster.health,
				drainState: cluster.drainState,
			};
		}),

	reconcileLeases: superadminProcedure.mutation(async ({ ctx }) => {
		const [capacity, operations] = await Promise.all([
			reconcileExpiredCapacityLeases(),
			reconcileExpiredOperationClaims(),
		]);
		await recordOperatorAudit({
			...operatorMetadata(ctx),
			action: "reconcile",
			resourceType: "capacityLease",
			metadata: {
				examined: capacity.examined,
				recovered: capacity.recovered.length,
				pending: capacity.pending.length,
				failed: capacity.failed.length,
				operations,
			},
		});
		return {
			capacity: {
				examined: capacity.examined,
				recovered: capacity.recovered.length,
				pending: capacity.pending.length,
				failed: capacity.failed.length,
			},
			operations,
		};
	}),

	classifyLegacy: superadminProcedure
		.input(
			z.object({
				legacyInfrastructureInputId: z.string().min(1),
				disposition: z.enum([
					"ambiguous",
					"platform_owned",
					"customer_owned",
					"rejected",
				]),
				reviewNote: z.string().trim().min(3).max(500),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const serverId = await resolveLegacyInfrastructureServerId(
				input.legacyInfrastructureInputId,
			);
			const record = await classifyLegacyInfrastructureInput(
				{
					serverId,
					disposition: input.disposition,
					reviewNote: input.reviewNote,
					reviewedBy: ctx.user.id,
				},
				{
					...operatorMetadata(ctx),
					action: "classify",
					resourceType: "legacyInfrastructureInput",
				},
			);
			return {
				legacyInfrastructureInputId: record?.legacyInfrastructureInputId,
				disposition: record?.disposition,
				reviewedAt: record?.reviewedAt,
			};
		}),

	exportLegacy: superadminProcedure
		.input(z.object({ legacyInfrastructureInputId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const serverId = await resolveLegacyInfrastructureServerId(
				input.legacyInfrastructureInputId,
			);
			const result = await exportLegacyInfrastructureInput(
				{ serverId, reviewedBy: ctx.user.id },
				{
					...operatorMetadata(ctx),
					action: "export",
					resourceType: "legacyInfrastructureInput",
				},
			);
			return {
				legacyInfrastructureInputId: result?.legacyInfrastructureInputId,
				disposition: result?.disposition,
				hasExport: Boolean(result?.exportPayload),
			};
		}),

	importLegacy: superadminProcedure
		.input(
			z.object({
				legacyInfrastructureInputId: z.string().min(1),
				runtimeClusterId: z.string().min(1),
				architecture,
				totalCpuMillis: z.number().int().positive(),
				totalMemoryMb: z.number().int().positive(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const serverId = await resolveLegacyInfrastructureServerId(
				input.legacyInfrastructureInputId,
			);
			const result = await importApprovedLegacyInfrastructureInput(
				{
					serverId,
					runtimeClusterId: input.runtimeClusterId,
					architecture: input.architecture,
					totalCpuMillis: input.totalCpuMillis,
					totalMemoryMb: input.totalMemoryMb,
					reviewedBy: ctx.user.id,
				},
				{
					...operatorMetadata(ctx),
					action: "import",
					resourceType: "legacyInfrastructureInput",
				},
			);
			return {
				legacyInfrastructureInputId:
					result.classification?.legacyInfrastructureInputId,
				disposition: result.classification?.disposition,
				runtimeClusterId: result.target.runtimeClusterId,
				health: result.target.health,
			};
		}),

	retireBootstrap: superadminProcedure
		.input(z.object({ legacyInfrastructureInputId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const serverId = await resolveLegacyInfrastructureServerId(
				input.legacyInfrastructureInputId,
			);
			await retireLegacyBootstrapAccess(serverId, {
				...operatorMetadata(ctx),
				action: "retire-bootstrap",
				resourceType: "legacyInfrastructureInput",
				resourceId: input.legacyInfrastructureInputId,
			});
			return { retired: true };
		}),

	registerCertificate: superadminProcedure
		.input(
			z.object({
				runtimeClusterId: z.string().min(1),
				enrollmentId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const certificate = await registerControllerCertificate(input, {
				...operatorMetadata(ctx),
				action: "rotate",
				resourceType: "controllerCertificate",
			});
			return {
				controllerCertificateId: certificate.controllerCertificateId,
				runtimeClusterId: certificate.runtimeClusterId,
				status: certificate.status,
				notBefore: certificate.notBefore,
				notAfter: certificate.notAfter,
				createdAt: certificate.createdAt,
			};
		}),

	revokeCertificate: superadminProcedure
		.input(
			z.object({
				controllerCertificateId: z.string().min(1),
				reason: z.string().trim().min(3).max(300),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const certificate = await revokeControllerCertificate(input, {
				...operatorMetadata(ctx),
				action: "revoke",
				resourceType: "controllerCertificate",
			});
			return {
				controllerCertificateId: certificate.controllerCertificateId,
				runtimeClusterId: certificate.runtimeClusterId,
				status: certificate.status,
				notBefore: certificate.notBefore,
				notAfter: certificate.notAfter,
				revokedAt: certificate.revokedAt,
			};
		}),

	createIncident: superadminProcedure
		.input(
			z.object({
				infrastructureProviderId: z.string().optional(),
				regionId: z.string().optional(),
				buildPoolId: z.string().optional(),
				runtimeClusterId: z.string().optional(),
				severity: z.enum(["info", "warning", "critical"]),
				title: safeOperatorText(3, 160),
				summary: safeOperatorText(3, 1_000),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const incident = await createInfrastructureIncident(
				{ ...input, openedBy: ctx.user.id },
				{
					...operatorMetadata(ctx),
					action: "create",
					resourceType: "infrastructureIncident",
				},
			);
			return {
				infrastructureIncidentId: incident?.infrastructureIncidentId,
				infrastructureProviderId: incident?.infrastructureProviderId,
				regionId: incident?.regionId,
				buildPoolId: incident?.buildPoolId,
				runtimeClusterId: incident?.runtimeClusterId,
				severity: incident?.severity,
				status: incident?.status,
				title: incident?.title,
				summary: incident?.summary,
				createdAt: incident?.createdAt,
			};
		}),

	resolveIncident: superadminProcedure
		.input(z.object({ infrastructureIncidentId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const incident = await resolveInfrastructureIncident(
				input.infrastructureIncidentId,
				{
					...operatorMetadata(ctx),
					action: "resolve",
					resourceType: "infrastructureIncident",
					resourceId: input.infrastructureIncidentId,
				},
			);
			return {
				infrastructureIncidentId: incident.infrastructureIncidentId,
				severity: incident.severity,
				status: incident.status,
				title: incident.title,
				summary: incident.summary,
				resolvedAt: incident.resolvedAt,
			};
		}),
});
