ALTER TABLE "compose" ADD COLUMN "deletedAt" timestamp with time zone;--> statement-breakpoint

CREATE OR REPLACE FUNCTION deploytide_reject_compose_hard_delete()
RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'compose records must be tombstoned, not deleted'
		USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER deploytide_compose_hard_delete_guard
BEFORE DELETE ON "compose"
FOR EACH ROW EXECUTE FUNCTION deploytide_reject_compose_hard_delete();