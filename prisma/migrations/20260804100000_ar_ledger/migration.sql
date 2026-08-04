-- CreateEnum
CREATE TYPE "ArTransactionType" AS ENUM ('CHARGE', 'PAYMENT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ArInvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PAID', 'VOID');

-- CreateTable
CREATE TABLE "ar_accounts" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profileId" TEXT,
    "creditLimit" DECIMAL(12,2),
    "termDays" INTEGER NOT NULL DEFAULT 30,
    "billingEmail" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ar_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ar_transactions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "type" "ArTransactionType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KRW',
    "description" TEXT NOT NULL,
    "reservationId" TEXT,
    "folioWindow" INTEGER,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ar_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ar_invoices" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "ArInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "total" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KRW',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" DATE NOT NULL,
    "sentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ar_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ar_accounts_propertyId_active_idx" ON "ar_accounts"("propertyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ar_accounts_propertyId_code_key" ON "ar_accounts"("propertyId", "code");

-- CreateIndex
CREATE INDEX "ar_transactions_accountId_postedAt_idx" ON "ar_transactions"("accountId", "postedAt");

-- CreateIndex
CREATE INDEX "ar_transactions_invoiceId_idx" ON "ar_transactions"("invoiceId");

-- CreateIndex
CREATE INDEX "ar_invoices_accountId_status_idx" ON "ar_invoices"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ar_invoices_propertyId_number_key" ON "ar_invoices"("propertyId", "number");

-- AddForeignKey
ALTER TABLE "ar_accounts" ADD CONSTRAINT "ar_accounts_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_accounts" ADD CONSTRAINT "ar_accounts_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_transactions" ADD CONSTRAINT "ar_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ar_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_transactions" ADD CONSTRAINT "ar_transactions_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "ar_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_transactions" ADD CONSTRAINT "ar_transactions_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_transactions" ADD CONSTRAINT "ar_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_invoices" ADD CONSTRAINT "ar_invoices_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_invoices" ADD CONSTRAINT "ar_invoices_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ar_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_invoices" ADD CONSTRAINT "ar_invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

