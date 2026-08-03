import { recordOperatorAudit } from "@dokploy/server";
import { validateRequest } from "@dokploy/server/lib/auth";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	assertOperatorAccessToken,
	assertOperatorLogoutRequest,
	assertOperatorSessionExchangeRequest,
	clearOperatorSessionCookie,
	consumeOperatorSessionExchangeAttempt,
	createOperatorSessionToken,
	resetOperatorSessionExchangeAttempts,
	setOperatorSessionCookie,
} from "@/server/operator-auth";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Pragma", "no-cache");
	if (req.method === "DELETE") {
		try {
			const { user } = await validateRequest(req);
			if (!user?.id || !user.email) throw new Error("Unauthorized");
			assertOperatorLogoutRequest({
				req,
				userId: user.id,
				email: user.email,
			});
			await recordOperatorAudit({
				actorUserId: user.id,
				actorEmail: user.email,
				action: "logout",
				resourceType: "operatorSession",
				requestId:
					typeof req.headers["x-request-id"] === "string"
						? req.headers["x-request-id"]
						: null,
			});
			clearOperatorSessionCookie(res);
			return res.status(204).end();
		} catch {
			return res.status(403).json({ error: "Operator request rejected" });
		}
	}
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST, DELETE");
		return res.status(405).json({ error: "Method not allowed" });
	}
	try {
		assertOperatorSessionExchangeRequest(req);
		const { user } = await validateRequest(req);
		if (!user?.id || !user.email) {
			return res.status(403).json({ error: "Operator authentication failed" });
		}
		consumeOperatorSessionExchangeAttempt({ req, userId: user.id });
		const accessToken =
			typeof req.body?.accessToken === "string"
				? req.body.accessToken
				: undefined;
		assertOperatorAccessToken(accessToken);
		const token = createOperatorSessionToken({
			userId: user.id,
			email: user.email,
			req,
		});
		await recordOperatorAudit({
			actorUserId: user.id,
			actorEmail: user.email,
			action: "mint",
			resourceType: "operatorSession",
			requestId:
				typeof req.headers["x-request-id"] === "string"
					? req.headers["x-request-id"]
					: null,
		});
		setOperatorSessionCookie(res, token);
		resetOperatorSessionExchangeAttempts({ req, userId: user.id });
		return res.status(204).end();
	} catch {
		return res.status(403).json({ error: "Operator authentication failed" });
	}
}

export const config = { api: { bodyParser: { sizeLimit: "8kb" } } };
