-- CreateEnum
CREATE TYPE "MembershipTier" AS ENUM ('NONE', 'SILVER', 'GOLD', 'PLATINUM');

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "membershipNumber" TEXT,
ADD COLUMN     "membershipTier" "MembershipTier" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "preferences" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "profiles_membershipNumber_idx" ON "profiles"("membershipNumber");

-- CreateIndex
CREATE INDEX "profiles_mergedIntoId_idx" ON "profiles"("mergedIntoId");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

