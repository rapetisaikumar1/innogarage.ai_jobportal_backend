CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "user_job_applications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "yourJobId" TEXT,
    "sourceListingId" TEXT,
    "sourceJobId" TEXT,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT,
    "datePostedText" TEXT,
    "postedAt" TIMESTAMP(3),
    "applyLink" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'JSEARCH',
    "rawPayload" JSONB,
    "matchingScore" INTEGER,
    "matchLabel" TEXT,
    "matchProvider" TEXT,
    "matchModel" TEXT,
    "matchSummary" TEXT,
    "matchWarning" TEXT,
    "matchBreakdown" JSONB,
    "strongMatches" JSONB,
    "missingSkills" JSONB,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_job_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_job_applications_yourJobId_key" ON "user_job_applications"("yourJobId");
CREATE UNIQUE INDEX "user_job_applications_userId_applyLink_key" ON "user_job_applications"("userId", "applyLink");
CREATE INDEX "user_job_applications_userId_appliedAt_idx" ON "user_job_applications"("userId", "appliedAt");
CREATE INDEX "user_job_applications_userId_status_appliedAt_idx" ON "user_job_applications"("userId", "status", "appliedAt");

ALTER TABLE "user_job_applications"
ADD CONSTRAINT "user_job_applications_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_job_applications"
ADD CONSTRAINT "user_job_applications_appliedById_fkey"
FOREIGN KEY ("appliedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_job_applications"
ADD CONSTRAINT "user_job_applications_yourJobId_fkey"
FOREIGN KEY ("yourJobId") REFERENCES "user_your_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_job_applications"
ADD CONSTRAINT "user_job_applications_sourceListingId_fkey"
FOREIGN KEY ("sourceListingId") REFERENCES "user_job_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "user_job_applications" (
    "id",
    "userId",
    "yourJobId",
    "sourceListingId",
    "sourceJobId",
    "title",
    "company",
    "location",
    "datePostedText",
    "postedAt",
    "applyLink",
    "source",
    "rawPayload",
    "matchingScore",
    "matchLabel",
    "matchProvider",
    "matchModel",
    "matchSummary",
    "matchWarning",
    "matchBreakdown",
    "strongMatches",
    "missingSkills",
    "status",
    "appliedAt",
    "appliedById",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    y."userId",
    y."id",
    y."sourceListingId",
    COALESCE(y."sourceJobId", l."sourceJobId"),
    y."title",
    y."company",
    y."location",
    y."datePostedText",
    y."postedAt",
    y."applyLink",
    y."source",
    COALESCE(y."rawPayload", l."rawPayload"),
    y."matchingScore",
    y."matchLabel",
    y."matchProvider",
    y."matchModel",
    y."matchSummary",
    y."matchWarning",
    y."matchBreakdown",
    y."strongMatches",
    y."missingSkills",
    'APPLIED',
    COALESCE(l."appliedAt", CURRENT_TIMESTAMP),
    l."appliedById",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "user_your_jobs" y
JOIN "user_job_listings" l ON l."id" = y."sourceListingId"
WHERE l."isApplied" = true
ON CONFLICT ("userId", "applyLink") DO NOTHING;