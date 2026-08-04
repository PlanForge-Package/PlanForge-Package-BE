-- CreateEnum
CREATE TYPE "TraceDepartment" AS ENUM ('FRONT_DESK', 'HOUSEKEEPING', 'MAINTENANCE', 'FNB', 'RESERVATION');

-- CreateEnum
CREATE TYPE "TraceStatus" AS ENUM ('PENDING', 'DONE');

-- CreateTable
CREATE TABLE "reservation_traces" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "department" "TraceDepartment" NOT NULL,
    "dueDate" DATE NOT NULL,
    "note" TEXT NOT NULL,
    "status" "TraceStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT,
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservation_traces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reservation_traces_propertyId_dueDate_department_status_idx" ON "reservation_traces"("propertyId", "dueDate", "department", "status");

-- CreateIndex
CREATE INDEX "reservation_traces_reservationId_idx" ON "reservation_traces"("reservationId");

-- AddForeignKey
ALTER TABLE "reservation_traces" ADD CONSTRAINT "reservation_traces_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_traces" ADD CONSTRAINT "reservation_traces_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_traces" ADD CONSTRAINT "reservation_traces_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_traces" ADD CONSTRAINT "reservation_traces_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

