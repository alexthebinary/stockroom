-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "feedbackEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Feedback" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "pageTitle" TEXT,
    "anchor" JSONB,
    "context" JSONB NOT NULL,
    "author" TEXT NOT NULL,
    "authorJob" TEXT,
    "screenshot" BYTEA,
    "screenshotType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Feedback_path_status_idx" ON "Feedback"("path", "status");

