-- AlterTable
ALTER TABLE "Run" ADD COLUMN "chatId" TEXT;
ALTER TABLE "Run" ADD COLUMN "telegramCommand" TEXT;

-- CreateIndex
CREATE INDEX "Run_chatId_telegramCommand_finishedAt_idx" ON "Run"("chatId", "telegramCommand", "finishedAt");
