-- Denormalise the hotel onto postings and payments.
--
-- The close journal and the daily report sum a hotel's ledger over a date range.
-- Reached through folio -> reservation, that filter cannot use an index: every row has
-- to be joined out before the hotel is known. These reports are the hottest read in the
-- system, so the column is worth its redundancy.
--
-- Added nullable, backfilled from the existing relation, then tightened. Doing it in
-- one step would fail on any database that already has rows.

ALTER TABLE "postings" ADD COLUMN "propertyId" TEXT;
ALTER TABLE "payments" ADD COLUMN "propertyId" TEXT;

UPDATE "postings" AS p
SET "propertyId" = r."propertyId"
FROM "folios" AS f
JOIN "reservations" AS r ON r."id" = f."reservationId"
WHERE f."id" = p."folioId";

UPDATE "payments" AS pay
SET "propertyId" = r."propertyId"
FROM "folios" AS f
JOIN "reservations" AS r ON r."id" = f."reservationId"
WHERE f."id" = pay."folioId";

-- A row whose folio or reservation is already gone has nothing to point at. There
-- should be none — both cascade — but the constraint would fail silently late.
DELETE FROM "postings" WHERE "propertyId" IS NULL;
DELETE FROM "payments" WHERE "propertyId" IS NULL;

ALTER TABLE "postings" ALTER COLUMN "propertyId" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "propertyId" SET NOT NULL;

CREATE INDEX "postings_propertyId_postedAt_idx" ON "postings"("propertyId", "postedAt");
CREATE INDEX "payments_propertyId_capturedAt_idx" ON "payments"("propertyId", "capturedAt");

ALTER TABLE "postings"
  ADD CONSTRAINT "postings_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
