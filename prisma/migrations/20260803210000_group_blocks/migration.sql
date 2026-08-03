-- CreateEnum
CREATE TYPE "BlockStatus" AS ENUM ('INQUIRY', 'TENTATIVE', 'DEFINITE', 'CANCELLED', 'ACTUAL');

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "blockCode" TEXT;

-- CreateTable
CREATE TABLE "blocks" (
    "id" TEXT NOT NULL,
    "operaBlockId" TEXT,
    "propertyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "BlockStatus" NOT NULL DEFAULT 'TENTATIVE',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "cutoffDate" DATE,
    "currency" TEXT NOT NULL DEFAULT 'KRW',
    "totalBlocked" INTEGER NOT NULL DEFAULT 0,
    "totalPickedUp" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "block_allotments" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "roomTypeCode" TEXT NOT NULL,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "pickedUp" INTEGER NOT NULL DEFAULT 0,
    "ratePlanCode" TEXT,
    "amount" DECIMAL(12,2),

    CONSTRAINT "block_allotments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blocks_operaBlockId_key" ON "blocks"("operaBlockId");

-- CreateIndex
CREATE INDEX "blocks_propertyId_startDate_idx" ON "blocks"("propertyId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_propertyId_code_key" ON "blocks"("propertyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "block_allotments_blockId_date_roomTypeCode_key" ON "block_allotments"("blockId", "date", "roomTypeCode");

-- CreateIndex
CREATE INDEX "reservations_propertyId_blockCode_idx" ON "reservations"("propertyId", "blockCode");

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "block_allotments" ADD CONSTRAINT "block_allotments_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

