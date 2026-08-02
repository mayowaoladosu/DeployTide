import { recordActivity } from "@dokploy/server/services/activity";

interface AuditCtx {
	user: { id: string; email: string; role: string };
	session: { activeOrganizationId: string };
}

interface AuditEvent {
	action: string;
	resourceType: string;
	resourceId?: string;
	resourceName?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Emits a structured operational activity event from a tRPC context.
 * Extracts userId, userEmail, userRole and organizationId automatically.
 *
 * Usage:
 *   await audit(ctx, { action: "create", resourceType: "project", resourceName: "my-app" });
 */
export const audit = (ctx: AuditCtx, event: AuditEvent) =>
	recordActivity({
		organizationId: ctx.session.activeOrganizationId,
		userId: ctx.user.id,
		userEmail: ctx.user.email,
		userRole: ctx.user.role,
		...event,
	});
