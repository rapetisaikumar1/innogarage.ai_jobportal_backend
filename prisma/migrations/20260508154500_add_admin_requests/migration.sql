-- CreateTable
CREATE TABLE "admin_requests" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "reviewedById" TEXT,
    "title" TEXT NOT NULL,
    "studentFullName" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "technology" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUEST_SENT',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_requests_adminId_createdAt_idx" ON "admin_requests"("adminId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_requests_status_createdAt_idx" ON "admin_requests"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "admin_requests" ADD CONSTRAINT "admin_requests_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_requests" ADD CONSTRAINT "admin_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;