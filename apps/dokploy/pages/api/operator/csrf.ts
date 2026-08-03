import { validateRequest } from "@dokploy/server/lib/auth";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	assertOperatorCsrfBootstrapRequest,
	readOperatorSession,
} from "@/server/operator-auth";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Pragma", "no-cache");
	res.setHeader("Content-Type", "application/json");
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		return res.status(405).json({ error: "Method not allowed" });
	}
	try {
		assertOperatorCsrfBootstrapRequest(req);
		const { user } = await validateRequest(req);
		if (!user?.id || !user.email) throw new Error("Unauthorized");
		const session = readOperatorSession({
			req,
			userId: user.id,
			email: user.email,
		});
		if (!session) throw new Error("Unauthorized");
		return res.status(200).json({ csrfToken: session.csrf });
	} catch {
		return res.status(401).json({ error: "Operator authentication required" });
	}
}
