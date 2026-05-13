CREATE TABLE "user_your_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceListingId" TEXT NOT NULL,
    "sourceJobId" TEXT,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT,
    "datePostedText" TEXT,
    "postedAt" TIMESTAMP(3),
    "applyLink" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'JSEARCH',
    "rawPayload" JSONB,
    "matchingScore" INTEGER NOT NULL,
    "matchLabel" TEXT NOT NULL,
    "matchProvider" TEXT NOT NULL DEFAULT 'fallback',
    "matchModel" TEXT,
    "matchSummary" TEXT,
    "matchWarning" TEXT,
    "matchBreakdown" JSONB,
    "strongMatches" JSONB,
    "missingSkills" JSONB,
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_your_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_your_jobs_sourceListingId_key" ON "user_your_jobs"("sourceListingId");
CREATE UNIQUE INDEX "user_your_jobs_userId_applyLink_key" ON "user_your_jobs"("userId", "applyLink");
CREATE INDEX "user_your_jobs_userId_matchingScore_updatedAt_idx" ON "user_your_jobs"("userId", "matchingScore", "updatedAt");

ALTER TABLE "user_your_jobs"
ADD CONSTRAINT "user_your_jobs_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_your_jobs"
ADD CONSTRAINT "user_your_jobs_sourceListingId_fkey"
FOREIGN KEY ("sourceListingId") REFERENCES "user_job_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
