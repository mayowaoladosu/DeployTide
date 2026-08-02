import dns from "node:dns";
import { promisify } from "node:util";
import { db } from "@dokploy/server/db";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { generateRandomDomain } from "@dokploy/server/templates";
import { manageDomain } from "@dokploy/server/utils/traefik/domain";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import {
	type apiCreateDomain,
	applications,
	compose,
	domains,
	previewDeployments,
} from "../db/schema";
import { findApplicationById } from "./application";
import { detectCDNProvider } from "./cdn";
import { findServerById } from "./server";

export type Domain = typeof domains.$inferSelect;

export const createDomain = async (input: z.infer<typeof apiCreateDomain>) => {
	const result = await db.transaction(async (tx) => {
		const targets = [
			input.applicationId,
			input.composeId,
			input.previewDeploymentId,
		].filter(Boolean);
		if (targets.length !== 1) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "A domain must target exactly one project resource",
			});
		}

		let ownership:
			| { organizationId: string; projectId: string; environmentId: string }
			| undefined;
		if (input.applicationId) {
			const application = await tx.query.applications.findFirst({
				where: eq(applications.applicationId, input.applicationId),
				columns: {
					organizationId: true,
					projectId: true,
					environmentId: true,
					deletedAt: true,
				},
			});
			if (application && !application.deletedAt) ownership = application;
		} else if (input.composeId) {
			const service = await tx.query.compose.findFirst({
				where: and(
					eq(compose.composeId, input.composeId),
					isNull(compose.deletedAt),
				),
				with: { environment: { with: { project: true } } },
			});
			if (service) {
				ownership = {
					organizationId: service.environment.project.organizationId,
					projectId: service.environment.projectId,
					environmentId: service.environmentId,
				};
			}
		} else if (input.previewDeploymentId) {
			const preview = await tx.query.previewDeployments.findFirst({
				where: eq(
					previewDeployments.previewDeploymentId,
					input.previewDeploymentId,
				),
				columns: {
					organizationId: true,
					projectId: true,
					environmentId: true,
					deletedAt: true,
				},
			});
			if (preview && !preview.deletedAt) ownership = preview;
		}
		if (!ownership) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Domain target not found",
			});
		}

		const domain = await tx
			.insert(domains)
			.values({
				...input,
				...ownership,
				host: input.host?.trim(),
			} as typeof domains.$inferInsert)
			.returning()
			.then((response) => response[0]);

		if (!domain) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating domain",
			});
		}

		if (domain.applicationId) {
			const application = await findApplicationById(domain.applicationId);
			await manageDomain(application, domain);
		}

		return domain;
	});

	return result;
};

export const generateTraefikMeDomain = async (
	appName: string,
	_userId: string,
	serverId?: string,
) => {
	if (serverId) {
		const server = await findServerById(serverId);
		return generateRandomDomain({
			serverIp: server.ipAddress,
			projectName: appName,
		});
	}

	if (process.env.NODE_ENV === "development") {
		return generateRandomDomain({
			serverIp: "",
			projectName: appName,
		});
	}
	const settings = await getWebServerSettings();
	return generateRandomDomain({
		serverIp: settings?.serverIp || "",
		projectName: appName,
	});
};

export const generateWildcardDomain = (
	appName: string,
	serverDomain: string,
) => {
	return `${appName}-${serverDomain}`;
};

export const findDomainById = async (domainId: string) => {
	const domain = await db.query.domains.findFirst({
		where: and(eq(domains.domainId, domainId), isNull(domains.deletedAt)),
		with: {
			application: {
				columns: { applicationId: true, appName: true, name: true },
			},
		},
	});
	if (!domain) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Domain not found",
		});
	}
	return domain;
};

export const findDomainsByApplicationId = async (applicationId: string) => {
	const domainsArray = await db.query.domains.findMany({
		where: and(
			eq(domains.applicationId, applicationId),
			isNull(domains.deletedAt),
		),
		with: {
			application: {
				columns: { applicationId: true, appName: true, name: true },
			},
		},
	});

	return domainsArray;
};

export const findDomainsByComposeId = async (composeId: string) => {
	const domainsArray = await db.query.domains.findMany({
		where: and(eq(domains.composeId, composeId), isNull(domains.deletedAt)),
		with: {
			compose: {
				columns: { composeId: true, appName: true, name: true },
			},
		},
	});

	return domainsArray;
};

export const updateDomainById = async (
	domainId: string,
	domainData: Partial<Domain>,
) => {
	const domain = await db
		.update(domains)
		.set({
			...domainData,
			...(domainData.host && { host: domainData.host.trim() }),
		})
		.where(and(eq(domains.domainId, domainId), isNull(domains.deletedAt)))
		.returning();

	return domain[0];
};

export const removeDomainById = async (domainId: string) => {
	await findDomainById(domainId);
	const result = await db
		.update(domains)
		.set({ deletedAt: new Date() })
		.where(and(eq(domains.domainId, domainId), isNull(domains.deletedAt)))
		.returning();

	return result[0];
};

export const getDomainHost = (domain: Domain) => {
	return `${domain.https ? "https" : "http"}://${domain.host}`;
};

const resolveDns = promisify(dns.resolve4);

export const validateDomain = async (
	domain: string,
	expectedIp?: string,
): Promise<{
	isValid: boolean;
	resolvedIp?: string;
	error?: string;
	isCloudflare?: boolean;
	cdnProvider?: string;
}> => {
	try {
		// Remove protocol and path if present
		const cleanDomain = domain.replace(/^https?:\/\//, "").split("/")[0];

		// Resolve the domain to get its IP
		const ips = await resolveDns(cleanDomain || "");

		const resolvedIps = ips.map((ip) => ip.toString());

		// Check if any IP belongs to a CDN provider
		const cdnProvider = ips
			.map((ip) => detectCDNProvider(ip))
			.find((provider) => provider !== null);

		// If behind a CDN, we consider it valid but inform the user
		if (cdnProvider) {
			return {
				isValid: true,
				resolvedIp: resolvedIps.join(", "),
				cdnProvider: cdnProvider.displayName,
				error: cdnProvider.warningMessage,
			};
		}

		// If we have an expected IP, validate against it
		if (expectedIp) {
			return {
				isValid: resolvedIps.includes(expectedIp),
				resolvedIp: resolvedIps.join(", "),
				error: !resolvedIps.includes(expectedIp)
					? `Domain resolves to ${resolvedIps.join(", ")} but should point to ${expectedIp}`
					: undefined,
			};
		}

		// If no expected IP, just return the resolved IP
		return {
			isValid: true,
			resolvedIp: resolvedIps.join(", "),
		};
	} catch (error) {
		return {
			isValid: false,
			error:
				error instanceof Error ? error.message : "Failed to resolve domain",
		};
	}
};
