-- AlterTable
ALTER TABLE "postings" ADD COLUMN     "transferredAt" TIMESTAMP(3),
ADD COLUMN     "transferredById" TEXT,
ADD COLUMN     "transferredFromWindow" INTEGER;

-- CreateTable
CREATE TABLE "folio_routings" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "transactionCode" TEXT NOT NULL,
    "targetWindow" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "folio_routings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "folio_routings_reservationId_transactionCode_key" ON "folio_routings"("reservationId", "transactionCode");

-- AddForeignKey
ALTER TABLE "folio_routings" ADD CONSTRAINT "folio_routings_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_routings" ADD CONSTRAINT "folio_routings_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postings" ADD CONSTRAINT "postings_transferredById_fkey" FOREIGN KEY ("transferredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
