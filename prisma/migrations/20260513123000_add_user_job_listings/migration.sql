CREATE TABLE "user_job_listings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceJobId" TEXT,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT,
    "datePostedText" TEXT,
    "postedAt" TIMESTAMP(3),
    "applyLink" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'JSEARCH',
    "rawPayload" JSONB,
    "isApplied" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_job_listings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_job_listings_userId_applyLink_key" ON "user_job_listings"("userId", "applyLink");
CREATE INDEX "user_job_listings_userId_lastSeenAt_idx" ON "user_job_listings"("userId", "lastSeenAt");
CREATE INDEX "user_job_listings_userId_isApplied_appliedAt_idx" ON "user_job_listings"("userId", "isApplied", "appliedAt");

ALTER TABLE "user_job_listings"
  ADD CONSTRAINT "user_job_listings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_job_listings"
  ADD CONSTRAINT "user_job_listings_appliedById_fkey"
  FOREIGN KEY ("appliedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;