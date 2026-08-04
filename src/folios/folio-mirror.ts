import { FolioStatus, Prisma, PostingType } from '@prisma/client';
import type { CoreFolio, CorePostingType } from '../core/core.types';

/** OPERA 표기 ↔ PlanForge 표기. 매핑을 한 곳에 모아 둔다. */
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
 * OPERA 가 확정한 폴리오를 로컬에 옮겨 적는다.
 *
 * 로컬 행은 캐시다. 잔액을 여기서 다시 계산하지 않는다 — 두 시스템이 각자 세면
 * 언젠가 값이 갈리고, 회계 데이터에서 그건 어느 쪽이 맞는지 판단할 근거가
 * 없다는 뜻이다.
 *
 * OPERA 가 모르는 것(어느 POS 아웃렛이 달았는지, 어느 결제가 만들었는지)은
 * 우리만 아는 정보이므로 갱신할 때 건드리지 않는다.
 */
export async function mirrorFolios(
  tx: Prisma.TransactionClient,
  reservationId: string,
  currency: string,
  folios: CoreFolio[],
): Promise<void> {
  const keptPostingIds: string[] = [];

  for (const folio of folios) {
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
        update: {
          // 이관하면 소속 창구가 바뀐다. 금액·적요는 OPERA 가 고칠 수 있다.
          folioId: saved.id,
          amount: new Prisma.Decimal(posting.amount),
          description: posting.description,
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
   * 취소 관계는 두 번째 바퀴에서 잇는다.
   *
   * OPERA 는 자기 식별자로 가리키므로, 상대 행이 먼저 만들어져 있어야 로컬
   * 식별자로 바꿀 수 있다.
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
   * OPERA 에 없는 거래는 지운다.
   *
   * 이관은 창구를 옮기므로 위에서 갱신되지만, 우리가 만들었다가 OPERA 가 받지
   * 않은 행이 남으면 잔액과 내역이 어긋난다. 로컬 원장을 OPERA 에 맞춘다.
   */
  const windows = folios.map((folio) => folio.window);
  await tx.posting.deleteMany({
    where: {
      folio: { reservationId, window: { in: windows } },
      id: { notIn: keptPostingIds.length > 0 ? keptPostingIds : ['-'] },
    },
  });
}
