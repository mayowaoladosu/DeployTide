import { completeControllerJob } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	authorizeRuntimeControllerRequest,
	CONTROLLER_RUNTIME_TARGET_HEADER,
	ControllerAuthenticationError,
	controllerNoStore,
	isControllerIdentifier,
} from "@/server/controller-auth";

const redactControllerValue = (value: unknown): unknown => {
	if (typeof value === "string") {
		return /(?:authorization\s*[:=]|bearer\s+|(?:secret|token|password|private.?key|credential)\s*[:=])/i.test(
			value,
		)
			? "[redacted]"
			: value;
	}
	if (Array.isArray(value)) return value.map(redactControllerValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [
				key,
				redactControllerValue(nested),
			]),
		);
	}
	return value;
};

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
	if (!Number.isFinite(contentLength) || contentLength > 96 * 1024) {
		return res.status(413).json({ error: "Controller result is too large" });
	}
	const clusterId = req.query.clusterId;
	const attemptId = req.query.attemptId;
	const runtimeTargetId = req.headers[CONTROLLER_RUNTIME_TARGET_HEADER];
	const body = req.body;
	const fencingToken = req.body?.fencingToken;
	const result = req.body?.result;
	if (
		typeof clusterId !== "string" ||
		typeof attemptId !== "string" ||
		!isControllerIdentifier(runtimeTargetId) ||
		!req.headers["content-type"]?.startsWith("application/json") ||
		!body ||
		typeof body !== "object" ||
		Array.isArray(body) ||
		Object.keys(body).length !== 2 ||
		!Object.hasOwn(body, "fencingToken") ||
		!Object.hasOwn(body, "result") ||
		!Number.isSafeInteger(fencingToken) ||
		fencingToken <= 0 ||
		!result ||
		typeof result !== "object" ||
		Array.isArray(result) ||
		Object.keys(result).some(
			(key) =>
				!["succeeded", "result", "retryable", "diagnostics"].includes(key),
		) ||
		!Object.hasOwn(result, "succeeded") ||
		!Object.hasOwn(result, "retryable") ||
		typeof result.succeeded !== "boolean" ||
		typeof result.retryable !== "boolean" ||
		(result.result !== undefined &&
			(!result.result ||
				typeof result.result !== "object" ||
				Array.isArray(result.result))) ||
		(result.diagnostics !== undefined &&
			(typeof result.diagnostics !== "string" ||
				result.diagnostics.length > 8_000)) ||
		(result.result !== undefined &&
			Buffer.byteLength(JSON.stringify(result.result), "utf8") > 64 * 1024)
	) {
		return res.status(400).json({ error: "Controller result is invalid" });
	}
	try {
		await authorizeRuntimeControllerRequest(req, clusterId, runtimeTargetId);
		await completeControllerJob({
			operatorJobAttemptId: attemptId,
			runtimeClusterId: clusterId,
			runtimeTargetId,
			fencingToken,
			succeeded: result.succeeded,
			result: result.result
				? (redactControllerValue(result.result) as Record<string, unknown>)
				: undefined,
			retryable: result.retryable === true,
			diagnostics:
				typeof result.diagnostics === "string"
					? "[redacted controller diagnostics]"
					: undefined,
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
		if (error instanceof TRPCError && error.code === "BAD_REQUEST") {
			return res.status(400).json({ error: "Controller result is invalid" });
		}
		return res.status(500).json({ error: "Controller result failed" });
	}
}

export const config = { api: { bodyParser: { sizeLimit: "96kb" } } };
