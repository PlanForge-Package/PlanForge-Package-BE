-- CreateEnum
CREATE TYPE "RoomOutageKind" AS ENUM ('OUT_OF_ORDER', 'OUT_OF_SERVICE');

-- CreateTable
CREATE TABLE "room_outages" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "operaId" TEXT NOT NULL,
    "kind" "RoomOutageKind" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "returnStatus" "RoomStatus" NOT NULL DEFAULT 'DIRTY',
    "createdById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_outages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "room_outages_operaId_key" ON "room_outages"("operaId");

-- CreateIndex
CREATE INDEX "room_outages_propertyId_startDate_endDate_idx" ON "room_outages"("propertyId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "room_outages_roomId_releasedAt_idx" ON "room_outages"("roomId", "releasedAt");

-- AddForeignKey
ALTER TABLE "room_outages" ADD CONSTRAINT "room_outages_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_outages" ADD CONSTRAINT "room_outages_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_outages" ADD CONSTRAINT "room_outages_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
