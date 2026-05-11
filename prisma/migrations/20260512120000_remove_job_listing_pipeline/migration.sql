-- Remove backend job-listing persistence and usage tracking.
DROP TABLE IF EXISTS "external_job_applications" CASCADE;
DROP TABLE IF EXISTS "tailored_resumes" CASCADE;
DROP TABLE IF EXISTS "job_applications" CASCADE;
DROP TABLE IF EXISTS "jobs" CASCADE;
DROP TABLE IF EXISTS "saved_job_results" CASCADE;

ALTER TABLE "users"
  DROP COLUMN IF EXISTS "jobSearchCount",
  DROP COLUMN IF EXISTS "lastSearchReset";

DROP TYPE IF EXISTS "ApplicationStatus";
DROP TYPE IF EXISTS "ApplicationType";
