ALTER TABLE "available_technologies"
ADD COLUMN IF NOT EXISTS "content" TEXT NOT NULL DEFAULT '';

ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "assignedTechnologyId" TEXT;

CREATE INDEX IF NOT EXISTS "users_assignedTechnologyId_idx" ON "users"("assignedTechnologyId");

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'users_assignedTechnologyId_fkey'
	) THEN
		ALTER TABLE "users"
		ADD CONSTRAINT "users_assignedTechnologyId_fkey"
		FOREIGN KEY ("assignedTechnologyId") REFERENCES "available_technologies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
	END IF;
END $$;