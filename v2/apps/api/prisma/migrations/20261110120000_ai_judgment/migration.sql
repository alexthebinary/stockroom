-- CreateTable
CREATE TABLE "AiJudgment" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "question" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "suggestion" JSONB NOT NULL,
    "band" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'PENDING',
    "outcomeValue" JSONB,
    "actor" TEXT,
    "latencyMs" INTEGER NOT NULL,
    "model" TEXT NOT NULL,

    CONSTRAINT "AiJudgment_pkey" PRIMARY KEY ("id")
);
