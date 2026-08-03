-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "channelCode" TEXT,
ADD COLUMN     "marketCode" TEXT,
ADD COLUMN     "sourceCode" TEXT;

-- CreateIndex
CREATE INDEX "reservations_propertyId_channelCode_idx" ON "reservations"("propertyId", "channelCode");

