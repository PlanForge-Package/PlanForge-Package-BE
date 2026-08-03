-- AlterTable
ALTER TABLE "postings" ADD COLUMN     "outletId" TEXT,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "voidedById" TEXT;

-- CreateTable
CREATE TABLE "pos_outlets" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "transactionCode" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "apiKeyPrefix" TEXT NOT NULL,
    "keyIssuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pos_outlets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pos_outlets_apiKeyPrefix_idx" ON "pos_outlets"("apiKeyPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "pos_outlets_propertyId_code_key" ON "pos_outlets"("propertyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "postings_voidedById_key" ON "postings"("voidedById");

-- CreateIndex
CREATE UNIQUE INDEX "postings_outletId_reference_key" ON "postings"("outletId", "reference");

-- AddForeignKey
ALTER TABLE "pos_outlets" ADD CONSTRAINT "pos_outlets_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postings" ADD CONSTRAINT "postings_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "pos_outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postings" ADD CONSTRAINT "postings_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "postings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

