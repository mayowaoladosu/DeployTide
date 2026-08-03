import { sql } from "drizzle-orm";
import {
	check,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { controllerCertificateStatus } from "./infrastructure-shared";
import { runtimeClusters } from "./runtime-cluster";

export const controllerCertificates = pgTable(
	"controllerCertificate",
	{
		controllerCertificateId: text("controllerCertificateId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		runtimeClusterId: text("runtimeClusterId")
			.notNull()
			.references(() => runtimeClusters.runtimeClusterId, {
				onDelete: "cascade",
			}),
		serialNumber: text("serialNumber").notNull(),
		subject: text("subject").notNull(),
		certificatePem: text("certificatePem").notNull(),
		privateKeyReference: text("privateKeyReference").notNull(),
		caFingerprint: text("caFingerprint").notNull(),
		status: controllerCertificateStatus("status").notNull().default("active"),
		notBefore: timestamp("notBefore", { withTimezone: true }).notNull(),
		notAfter: timestamp("notAfter", { withTimezone: true }).notNull(),
		createdAt: timestamp("createdAt", { withTimezone: true })
			.notNull()
			.defaultNow(),
		revokedAt: timestamp("revokedAt", { withTimezone: true }),
		revocationReason: text("revocationReason"),
	},
	(table) => [
		uniqueIndex("controller_certificate_serial_unique").on(table.serialNumber),
		index("controller_certificate_cluster_status_idx").on(
			table.runtimeClusterId,
			table.status,
		),
		index("controller_certificate_expiry_idx").on(table.status, table.notAfter),
		check(
			"controller_certificate_external_key_reference",
			sql`${table.privateKeyReference} LIKE 'operator-secret-id://%'`,
		),
	],
);

export type ControllerCertificate = typeof controllerCertificates.$inferSelect;
