import { heartbeatRuntimeController } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	authorizeRuntimeControllerRequest,
	CONTROLLER_RUNTIME_TARGET_HEADER,
	ControllerAuthenticationError,
	controllerNoStore,
	isControllerIdentifier,
} from "@/server/controller-auth";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	for (const [key, value] of Object.entries(controllerNoStore))
		res.setHeader(key, value);
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		return res.status(405).json({ error: "Method not allowed" });
	}
	const contentLength = Number(req.headers["content-length"] ?? 0);
	if (!Number.isFinite(contentLength) || contentLength > 16 * 1024) {
		return res.status(413).json({ error: "Controller heartbeat is too large" });
	}
	const clusterId = req.query.clusterId;
	const runtimeTargetId = req.headers[CONTROLLER_RUNTIME_TARGET_HEADER];
	const body = req.body;
	const bodyRuntimeTargetId =
		typeof req.body?.runtimeTargetId === "string"
			? req.body.runtimeTargetId
			: "";
	const version = typeof req.body?.version === "string" ? req.body.version : "";
	const health = req.body?.health;
	if (
		typeof clusterId !== "string" ||
		!isControllerIdentifier(runtimeTargetId) ||
		!req.headers["content-type"]?.startsWith("application/json") ||
		!body ||
		typeof body !== "object" ||
		Array.isArray(body) ||
		Object.keys(body).length !== 3 ||
		!["runtimeTargetId", "version", "health"].every((key) =>
			Object.hasOwn(body, key),
		) ||
		!isControllerIdentifier(bodyRuntimeTargetId) ||
		bodyRuntimeTargetId !== runtimeTargetId ||
		!version ||
		version.length > 80 ||
		!(["healthy", "degraded", "unavailable"] as unknown[]).includes(health)
	) {
		return res.status(400).json({ error: "Controller heartbeat is invalid" });
	}
	try {
		await authorizeRuntimeControllerRequest(req, clusterId, runtimeTargetId);
		await heartbeatRuntimeController({
			runtimeClusterId: clusterId,
			runtimeTargetId,
			controllerVersion: version,
			health,
		});
		return res.status(204).end();
	} catch (error) {
		if (error instanceof ControllerAuthenticationError) {
			return res
				.status(401)
				.json({ error: "Controller authentication failed" });
		}
		if (error instanceof TRPCError && error.code === "NOT_FOUND") {
			return res
				.status(409)
				.json({ error: "Controller target state conflicts" });
		}
		return res.status(500).json({ error: "Controller heartbeat failed" });
	}
}

export const config = { api: { bodyParser: { sizeLimit: "16kb" } } };
