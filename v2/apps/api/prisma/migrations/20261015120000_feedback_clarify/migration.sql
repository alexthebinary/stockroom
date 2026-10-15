ALTER TABLE "Feedback"
  ADD COLUMN "spec" JSONB,
  ADD COLUMN "specState" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN "autoState" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN "autoNote" TEXT,
  ADD COLUMN "autoCommit" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "autoClaim" TEXT,
  ADD COLUMN "autoRevision" INTEGER;

CREATE TABLE "FeedbackTurn" (
  "id" SERIAL NOT NULL,
  "feedbackId" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeedbackTurn_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FeedbackTurn_feedbackId_idx" ON "FeedbackTurn"("feedbackId");
ALTER TABLE "FeedbackTurn" ADD CONSTRAINT "FeedbackTurn_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;
