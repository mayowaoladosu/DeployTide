import { getNextSignedControllerJob } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	authorizeRuntimeControllerRequest,
	CONTROLLER_RUNTIME_TARGET_HEADER,
	ControllerAuthenticationError,
	controllerNoStore,
	isControllerIdentifier,
	readControllerSigningPrivateKey,
} from "@/server/controller-auth";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	for (const [key, value] of Object.entries(controllerNoStore))
		res.setHeader(key, value);
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		return res.status(405).json({ error: "Method not allowed" });
	}
	const clusterId = req.query.clusterId;
	const runtimeTargetId = req.headers[CONTROLLER_RUNTIME_TARGET_HEADER];
	const rawAfterSequence = req.query.afterSequence ?? "0";
	const queryKeys = Object.keys(req.query);
	const afterSequence =
		typeof rawAfterSequence === "string" &&
		/^(0|[1-9][0-9]*)$/.test(rawAfterSequence)
			? Number(rawAfterSequence)
			: Number.NaN;
	if (
		typeof clusterId !== "string" ||
		!clusterId ||
		!isControllerIdentifier(runtimeTargetId) ||
		queryKeys.some((key) => !["clusterId", "afterSequence"].includes(key)) ||
		!Number.isSafeInteger(afterSequence) ||
		afterSequence < 0
	) {
		return res
			.status(400)
			.json({ error: "Controller poll request is invalid" });
	}
	try {
		await authorizeRuntimeControllerRequest(req, clusterId, runtimeTargetId);
		const job = await getNextSignedControllerJob({
			runtimeClusterId: clusterId,
			runtimeTargetId,
			afterSequence,
			privateKeyPem: await readControllerSigningPrivateKey(),
		});
		return res.status(200).json({ job });
	} catch (error) {
		if (error instanceof ControllerAuthenticationError) {
			return res
				.status(401)
				.json({ error: "Controller authentication failed" });
		}
		if (error instanceof TRPCError && error.code === "CONFLICT") {
			return res.status(409).json({ error: "Controller job state conflicts" });
		}
		return res.status(500).json({ error: "Controller job poll failed" });
	}
}
