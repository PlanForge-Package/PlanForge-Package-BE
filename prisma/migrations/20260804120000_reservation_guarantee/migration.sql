-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "cancellationPenalty" DECIMAL(12,2),
ADD COLUMN     "guaranteeCode" TEXT;
