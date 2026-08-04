import { FolioStatus, Prisma, PostingType } from '@prisma/client';
import type { CoreFolio, CorePostingType } from '../core/core.types';

/** OPERA terms to PlanForge terms. The mapping is kept in one place. */
const TO_OPERA_TYPE: Record<PostingType, CorePostingType> = {
  [PostingType.CHARGE]: 'Charge',
  [PostingType.PAYMENT]: 'Payment',
  [PostingType.ADJUSTMENT]: 'Adjustment',
  [PostingType.TAX]: 'Tax',
};

const FROM_OPERA_TYPE: Record<CorePostingType, PostingType> = {
  Charge: PostingType.CHARGE,
  Payment: PostingType.PAYMENT,
  Adjustment: PostingType.ADJUSTMENT,
  Tax: PostingType.TAX,
};

export function toOperaPostingType(type: PostingType): CorePostingType {
  return TO_OPERA_TYPE[type];
}

/**
 * Copies the folio OPERA confirmed into the local rows.
 *
 * Local rows are a cache. The balance is never recomputed here — two systems
 * counting separately eventually disagree, and in accounting data there is no way
 * to tell which side is right.
 *
 * What OPERA does not know (which POS outlet posted it, which payment created it)
 * is ours alone, so it is left untouched on update.
 */
export async function mirrorFolios(
  tx: Prisma.TransactionClient,
  reservationId: string,
  currency: string,
  folios: CoreFolio[],
): Promise<void> {
  const keptPostingIds: string[] = [];

  for (const folio of folios) {
    /*
     * Another row holding the same OPERA id is the stale one.
     *
     * The copy's unique constraint is a consistency device, not a business rule. An
     * exception here would raise a 500 after money already moved, leaving a payment
     * that exists in OPERA but not on our screen. We follow what OPERA says now.
     */
    await tx.folio.updateMany({
      where: {
        operaFolioId: folio.folioId,
        OR: [{ reservationId: { not: reservationId } }, { window: { not: folio.window } }],
      },
      data: { operaFolioId: null },
    });

    const saved = await tx.folio.upsert({
      where: { reservationId_window: { reservationId, window: folio.window } },
      update: {
        operaFolioId: folio.folioId,
        status: folio.status === 'Closed' ? FolioStatus.CLOSED : FolioStatus.OPEN,
        balance: new Prisma.Decimal(folio.balance),
      },
      create: {
        reservationId,
        window: folio.window,
        operaFolioId: folio.folioId,
        status: folio.status === 'Closed' ? FolioStatus.CLOSED : FolioStatus.OPEN,
        balance: new Prisma.Decimal(folio.balance),
        currency: folio.currencyCode || currency,
      },
    });

    for (const posting of folio.postings) {
      const local = await tx.posting.upsert({
        where: { operaPostingId: posting.postingId },
        /*
         * Everything that arrived is written.
         *
         * Updating only part leaves the copy holding values OPERA does not have — a
         * stale transaction code posts that amount to the wrong revenue at close.
         * This row is a copy of their record, not one we made.
         */
        update: {
          folioId: saved.id,
          type: FROM_OPERA_TYPE[posting.type] ?? PostingType.CHARGE,
          transactionCode: posting.transactionCode,
          amount: new Prisma.Decimal(posting.amount),
          description: posting.description,
          currency: posting.currencyCode || folio.currencyCode || currency,
          ...(posting.postedAt ? { postedAt: new Date(posting.postedAt) } : {}),
          reference: posting.reference ?? null,
          transferredFromWindow: posting.transferredFromWindow ?? null,
        },
        create: {
          operaPostingId: posting.postingId,
          folioId: saved.id,
          type: FROM_OPERA_TYPE[posting.type] ?? PostingType.CHARGE,
          transactionCode: posting.transactionCode,
          description: posting.description,
          amount: new Prisma.Decimal(posting.amount),
          currency: posting.currencyCode || folio.currencyCode || currency,
          postedAt: posting.postedAt ? new Date(posting.postedAt) : new Date(),
          reference: posting.reference ?? null,
          transferredFromWindow: posting.transferredFromWindow ?? null,
        },
      });
      keptPostingIds.push(local.id);
    }
  }

  /*
   * Void relations are linked on a second pass.
   *
   * OPERA points with its own ids, so the other row has to exist before it can be
   * translated into a local id.
   */
  for (const folio of folios) {
    for (const posting of folio.postings) {
      if (!posting.voidedById) continue;
      const [original, reversal] = await Promise.all([
        tx.posting.findUnique({
          where: { operaPostingId: posting.postingId },
          select: { id: true, voidedById: true },
        }),
        tx.posting.findUnique({
          where: { operaPostingId: posting.voidedById },
          select: { id: true },
        }),
      ]);
      if (original && reversal && original.voidedById !== reversal.id) {
        await tx.posting.update({
          where: { id: original.id },
          data: { voidedById: reversal.id },
        });
      }
    }
  }

  /*
   * Transactions OPERA does not have are deleted.
   *
   * A transfer moves a window and is updated above, but a row we created and OPERA
   * never accepted would skew the balance and the detail. The local ledger follows OPERA.
   */
  const windows = folios.map((folio) => folio.window);
  await tx.posting.deleteMany({
    where: {
      folio: { reservationId, window: { in: windows } },
      id: { notIn: keptPostingIds.length > 0 ? keptPostingIds : ['-'] },
    },
  });
}
