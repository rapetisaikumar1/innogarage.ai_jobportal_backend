ALTER TABLE "user_job_applications"
ALTER COLUMN "status" SET DEFAULT 'student applied';

UPDATE "user_job_applications"
SET "status" = CASE
  WHEN "appliedById" IS NOT NULL THEN 'mentor applied'
  ELSE 'student applied'
END
WHERE "status" = 'APPLIED';