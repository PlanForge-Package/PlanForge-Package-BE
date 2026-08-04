-- AlterTable
ALTER TABLE "postings" ADD COLUMN     "operaPostingId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "postings_operaPostingId_key" ON "postings"("operaPostingId");
