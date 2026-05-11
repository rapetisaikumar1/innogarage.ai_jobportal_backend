DO $$
BEGIN
  IF to_regclass('public.sheet_job_applications') IS NOT NULL
     AND to_regclass('public.external_job_applications') IS NULL THEN
    ALTER TABLE "sheet_job_applications" RENAME TO "external_job_applications";
  ELSIF to_regclass('public.sheet_job_applications') IS NOT NULL
     AND to_regclass('public.external_job_applications') IS NOT NULL THEN
    INSERT INTO "external_job_applications" (
      "id",
      "userId",
      "jobLink",
      "employerName",
      "jobTitle",
      "status",
      "appliedMethod",
      "appliedById",
      "matchScore",
      "pdfLink",
      "reportUrl",
      "createdAt"
    )
    SELECT
      "id",
      "userId",
      "jobLink",
      "employerName",
      "jobTitle",
      "status",
      "appliedMethod",
      "appliedById",
      "matchScore",
      "pdfLink",
      "reportUrl",
      "createdAt"
    FROM "sheet_job_applications"
    ON CONFLICT ("userId", "jobLink") DO NOTHING;

    DROP TABLE "sheet_job_applications";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sheet_job_applications_pkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_job_applications_pkey') THEN
    ALTER TABLE "external_job_applications" RENAME CONSTRAINT "sheet_job_applications_pkey" TO "external_job_applications_pkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sheet_job_applications_userId_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_job_applications_userId_fkey') THEN
    ALTER TABLE "external_job_applications" RENAME CONSTRAINT "sheet_job_applications_userId_fkey" TO "external_job_applications_userId_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'sheet_job_applications_userId_createdAt_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'external_job_applications_userId_createdAt_idx') THEN
    ALTER INDEX "sheet_job_applications_userId_createdAt_idx" RENAME TO "external_job_applications_userId_createdAt_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'sheet_job_applications_userId_appliedById_idx')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'external_job_applications_userId_appliedById_idx') THEN
    ALTER INDEX "sheet_job_applications_userId_appliedById_idx" RENAME TO "external_job_applications_userId_appliedById_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'sheet_job_applications_userId_jobLink_key')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'external_job_applications_userId_jobLink_key') THEN
    ALTER INDEX "sheet_job_applications_userId_jobLink_key" RENAME TO "external_job_applications_userId_jobLink_key";
  END IF;
END $$;