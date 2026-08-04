-- CreateTable
CREATE TABLE "ar_allocations" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ar_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ar_allocations_paymentId_idx" ON "ar_allocations"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ar_allocations_invoiceId_paymentId_key" ON "ar_allocations"("invoiceId", "paymentId");

-- AddForeignKey
ALTER TABLE "ar_allocations" ADD CONSTRAINT "ar_allocations_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "ar_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_allocations" ADD CONSTRAINT "ar_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "ar_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_allocations" ADD CONSTRAINT "ar_allocations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
