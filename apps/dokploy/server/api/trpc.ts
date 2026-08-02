/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */

// import { getServerAuthSession } from "@/server/auth";
import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@dokploy/server/db";
import { organization } from "@dokploy/server/db/schema";
import type { statements } from "@dokploy/server/lib/access-control";
import { validateRequest } from "@dokploy/server/lib/auth";
import { checkPermission } from "@dokploy/server/services/permission";
import type { OpenApiMeta } from "@dokploy/trpc-openapi";
import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateNextContextOptions } from "@trpc/server/adapters/next";
import type { Session, User } from "better-auth";
import { and, eq, isNull } from "drizzle-orm";
import superjson from "superjson";
import { ZodError } from "zod";

type Resource = keyof typeof statements;
type ActionOf<R extends Resource> = (typeof statements)[R][number];

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the database, the session, etc.
 */

interface CreateContextOptions {
	user:
		| (User & {
				role: "member" | "admin" | "owner";
				ownerId: string;
		  })
		| null;
	session:
		| (Session & { activeOrganizationId: string; impersonatedBy?: string })
		| null;
	req: CreateNextContextOptions["req"];
	res: CreateNextContextOptions["res"];
}

/**
 * This helper generates the "internals" for a tRPC context. If you need to use it, you can export
 * it from here.
 *
 * Examples of things you may need it for:
 * - testing, so we don't have to mock Next.js' req/res
 * - tRPC's `createSSGHelpers`, where we don't have req/res
 *
 * @see https://create.t3.gg/en/usage/trpc#-serverapitrpcts
 */
const createInnerTRPCContext = (opts: CreateContextOptions) => {
	return {
		session: opts.session,
		db,
		req: opts.req,
		res: opts.res,
		user: opts.user,
	};
};

/**
 * This is the actual context you will use in your router. It will be used to process every request
 * that goes through your tRPC endpoint.
 *
 * @see https://trpc.io/docs/context
 */
export const createTRPCContext = async (opts: CreateNextContextOptions) => {
	const { req, res } = opts;

	// Get from the request
	const { session, user } = await validateRequest(req);

	return createInnerTRPCContext({
		req,
		res,
		// @ts-ignore
		session: session
			? {
					...session,
					activeOrganizationId: session.activeOrganizationId || "",
				}
			: null,
		// @ts-ignore
		user: user
			? {
					...user,
					email: user.email,
					role: user.role as "owner" | "member" | "admin",
					id: user.id,
					ownerId: user.ownerId,
				}
			: null,
	});
};

/**
 * 2. INITIALIZATION
 *
 * This is where the tRPC API is initialized, connecting the context and transformer. We also parse
 * ZodErrors so that you get type safety on the frontend if your procedure fails due to validation
 * errors on the backend.
 */

const t = initTRPC
	.meta<OpenApiMeta>()
	.context<typeof createTRPCContext>()
	.create({
		transformer: superjson,
		errorFormatter({ shape, error }) {
			return {
				...shape,
				data: {
					...shape.data,
					zodError:
						error.cause instanceof ZodError ? error.cause.flatten() : null,
				},
			};
		},
	});

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these a lot in the
 * "/src/server/api/routers" directory.
 */

/**
 * This is how you create new routers and sub-routers in your tRPC API.
 *
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router;

/**
 * Public (unauthenticated) procedure
 *
 * This is the base piece you use to build new queries and mutations on your tRPC API. It does not
 * guarantee that a user querying is authorized, but you can still access user session data if they
 * are logged in.
 */
export const publicProcedure = t.procedure;

/**
 * Protected (authenticated) procedure
 *
 * If you want a query or mutation to ONLY be accessible to logged in users, use this. It verifies
 * the session is valid and guarantees `ctx.session.user` is not null.
 *
 * @see https://trpc.io/docs/procedures
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
	if (!ctx.session || !ctx.user) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
	if (ctx.session.activeOrganizationId) {
		const activeWorkspace = await db.query.organization.findFirst({
			where: and(
				eq(organization.id, ctx.session.activeOrganizationId),
				isNull(organization.deletedAt),
			),
			columns: { id: true },
		});
		if (!activeWorkspace) {
			throw new TRPCError({ code: "UNAUTHORIZED" });
		}
	}
	return next({
		ctx: {
			// infers the `session` as non-nullable
			session: ctx.session,
			user: ctx.user,
			// session: { ...ctx.session, user: ctx.user },
		},
	});
});

export const assertOperatorRequest = (
	req: CreateNextContextOptions["req"],
): void => {
	const expected = process.env.DEPLOYTIDE_OPERATOR_API_TOKEN;
	const raw = req.headers["x-deploytide-operator-token"];
	const provided = Array.isArray(raw) ? raw[0] : raw;
	if (!expected || !provided) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
	const expectedDigest = createHash("sha256").update(expected).digest();
	const providedDigest = createHash("sha256").update(provided).digest();
	if (!timingSafeEqual(expectedDigest, providedDigest)) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
};

/**
 * Compatibility boundary for infrastructure routers retained until Phase 4.
 * A normal customer session is intentionally insufficient.
 */
export const operatorProcedure = protectedProcedure.use(({ ctx, next }) => {
	assertOperatorRequest(ctx.req);
	return next();
});

export const cliProcedure = t.procedure.use(({ ctx, next }) => {
	if (
		!ctx.session ||
		!ctx.user ||
		(ctx.user.role !== "owner" && ctx.user.role !== "admin")
	) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
	return next({
		ctx: {
			// infers the `session` as non-nullable
			session: ctx.session,
			user: ctx.user,
			// session: { ...ctx.session, user: ctx.user },
		},
	});
});

export const adminProcedure = t.procedure.use(({ ctx, next }) => {
	if (
		!ctx.session ||
		!ctx.user ||
		(ctx.user.role !== "owner" && ctx.user.role !== "admin")
	) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
	return next({
		ctx: {
			// infers the `session` as non-nullable
			session: ctx.session,
			user: ctx.user,
			// session: { ...ctx.session, user: ctx.user },
		},
	});
});

/**
 * Permission-checked procedure factory.
 *
 * Verifies the caller has the required resource+action permission before the
 * handler runs. Works for all role types:
 * - owner / admin  → static administrative roles
 * - member         → static role plus explicit legacy resource overrides
 *
 * Usage:
 *   create: withPermission("project", "create")
 *     .input(...)
 *     .mutation(async ({ ctx, input }) => { ... })
 */
export const withPermission = <R extends Resource>(
	resource: R,
	action: ActionOf<R>,
) =>
	protectedProcedure.use(async ({ ctx, next }) => {
		await checkPermission(ctx, { [resource]: [action] } as any);
		return next();
	});
