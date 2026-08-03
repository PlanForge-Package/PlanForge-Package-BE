-- CreateEnum
CREATE TYPE "RoomKeyStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "room_keys" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "roomNumber" TEXT NOT NULL,
    "vendorKeyId" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "status" "RoomKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "room_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_keys_reservationId_status_idx" ON "room_keys"("reservationId", "status");

-- CreateIndex
CREATE INDEX "room_keys_propertyId_roomNumber_status_idx" ON "room_keys"("propertyId", "roomNumber", "status");

-- CreateIndex
CREATE UNIQUE INDEX "room_keys_propertyId_vendorKeyId_key" ON "room_keys"("propertyId", "vendorKeyId");

-- AddForeignKey
ALTER TABLE "room_keys" ADD CONSTRAINT "room_keys_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_keys" ADD CONSTRAINT "room_keys_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_keys" ADD CONSTRAINT "room_keys_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

