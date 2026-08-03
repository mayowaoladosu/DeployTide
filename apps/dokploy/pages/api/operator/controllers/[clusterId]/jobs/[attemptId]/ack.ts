import { acknowledgeControllerJob } from "@dokploy/server";
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
	if (!Number.isFinite(contentLength) || contentLength > 8 * 1024) {
		return res
			.status(413)
			.json({ error: "Controller acknowledgement is too large" });
	}
	const clusterId = req.query.clusterId;
	const attemptId = req.query.attemptId;
	const runtimeTargetId = req.headers[CONTROLLER_RUNTIME_TARGET_HEADER];
	const body = req.body;
	const fencingToken = req.body?.fencingToken;
	if (
		typeof clusterId !== "string" ||
		typeof attemptId !== "string" ||
		!isControllerIdentifier(runtimeTargetId) ||
		!req.headers["content-type"]?.startsWith("application/json") ||
		!body ||
		typeof body !== "object" ||
		Array.isArray(body) ||
		Object.keys(body).length !== 1 ||
		!Object.hasOwn(body, "fencingToken") ||
		!Number.isSafeInteger(fencingToken) ||
		fencingToken <= 0
	) {
		return res
			.status(400)
			.json({ error: "Controller acknowledgement is invalid" });
	}
	try {
		await authorizeRuntimeControllerRequest(req, clusterId, runtimeTargetId);
		await acknowledgeControllerJob({
			operatorJobAttemptId: attemptId,
			runtimeClusterId: clusterId,
			runtimeTargetId,
			fencingToken,
		});
		return res.status(204).end();
	} catch (error) {
		if (error instanceof ControllerAuthenticationError) {
			return res
				.status(401)
				.json({ error: "Controller authentication failed" });
		}
		if (
			error instanceof TRPCError &&
			(error.code === "CONFLICT" || error.code === "NOT_FOUND")
		) {
			return res.status(409).json({ error: "Controller job state conflicts" });
		}
		return res.status(500).json({ error: "Controller acknowledgement failed" });
	}
}

export const config = { api: { bodyParser: { sizeLimit: "8kb" } } };
