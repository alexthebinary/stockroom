-- Questions the build team asks Serhii from the Feedback page.
CREATE TABLE "TeamQuestion" (
    "id" SERIAL NOT NULL,
    "text" TEXT NOT NULL,
    "context" TEXT,
    "feedbackIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "askedBy" TEXT NOT NULL DEFAULT 'Claude',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "answeredBy" TEXT,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamQuestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TeamQuestion_status_idx" ON "TeamQuestion"("status");
