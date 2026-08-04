import { FolioStatus, PostingType, Prisma } from '@prisma/client';
import type { CoreFolio } from '../core/core.types';
import { mirrorFolios, toOperaPostingType } from './folio-mirror';

function buildTx(overrides: Record<string, unknown> = {}) {
  return {
    folio: {
      upsert: jest.fn().mockImplementation(({ create, where }) => ({
        id: `folio-${where.reservationId_window.window}`,
        ...create,
      })),
      updateMany: jest.fn(),
    },
    posting: {
      upsert: jest.fn().mockImplementation(({ where, create }) => ({
        id: `local-${where.operaPostingId}`,
        ...create,
      })),
      findUnique: jest.fn().mockImplementation(({ where }) => ({
        id: `local-${where.operaPostingId}`,
        voidedById: null,
      })),
      update: jest.fn(),
      deleteMany: jest.fn(),
      ...((overrides.posting as object) ?? {}),
    },
  };
}

function folio(overrides: Partial<CoreFolio> = {}): CoreFolio {
  return {
    folioId: 'FOL-801',
    reservationId: 'RSV-1',
    window: 1,
    status: 'Open',
    balance: 240000,
    currencyCode: 'KRW',
    postings: [
      {
        postingId: 'PST-801',
        type: 'Charge',
        transactionCode: '1000',
        description: '객실료',
        amount: 240000,
        currencyCode: 'KRW',
        postedAt: '2026-08-04T01:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('folio-mirror — 거래 종류 매핑', () => {
  it.each([
    [PostingType.CHARGE, 'Charge'],
    [PostingType.PAYMENT, 'Payment'],
    [PostingType.ADJUSTMENT, 'Adjustment'],
    [PostingType.TAX, 'Tax'],
  ])('%s 를 %s 로 보낸다', (local, opera) => {
    expect(toOperaPostingType(local)).toBe(opera);
  });
});

describe('folio-mirror', () => {
  // 두 시스템이 각자 세면 언젠가 값이 갈린다. 저쪽 잔액을 그대로 쓴다.
  it('잔액을 다시 계산하지 않고 OPERA 값을 그대로 쓴다', async () => {
    const tx = buildTx();
    await mirrorFolios(tx as never, 'res-1', 'KRW', [folio({ balance: 123456 })]);

    const upserted = tx.folio.upsert.mock.calls[0][0];
    expect(upserted.update.balance.toString()).toBe('123456');
    expect(upserted.create.balance.toString()).toBe('123456');
  });

  it('마감 상태를 옮긴다', async () => {
    const tx = buildTx();
    await mirrorFolios(tx as never, 'res-1', 'KRW', [folio({ status: 'Closed' })]);

    expect(tx.folio.upsert.mock.calls[0][0].update.status).toBe(FolioStatus.CLOSED);
  });

  it('거래를 OPERA 식별자로 맞춘다', async () => {
    const tx = buildTx();
    await mirrorFolios(tx as never, 'res-1', 'KRW', [folio()]);

    expect(tx.posting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { operaPostingId: 'PST-801' } }),
    );
  });

  /*
   * 어느 POS 아웃렛이 달았는지, 어느 결제가 만들었는지는 OPERA 가 모른다.
   * 갱신할 때 건드리면 사본에서만 아는 정보가 사라진다.
   */
  it('갱신에서는 아웃렛·결제 연결을 건드리지 않는다', async () => {
    const tx = buildTx();
    await mirrorFolios(tx as never, 'res-1', 'KRW', [folio()]);

    const update = tx.posting.upsert.mock.calls[0][0].update;
    expect(update).not.toHaveProperty('outletId');
    expect(update).not.toHaveProperty('paymentId');
  });

  it('이관되면 소속 창구와 출처를 갱신한다', async () => {
    const tx = buildTx();
    await mirrorFolios(tx as never, 'res-1', 'KRW', [
      folio({
        window: 2,
        postings: [
          {
            postingId: 'PST-801',
            type: 'Charge',
            transactionCode: '1000',
            description: '객실료',
            amount: 240000,
            currencyCode: 'KRW',
            postedAt: '2026-08-04T01:00:00.000Z',
            transferredFromWindow: 1,
          },
        ],
      }),
    ]);

    const update = tx.posting.upsert.mock.calls[0][0].update;
    expect(update.folioId).toBe('folio-2');
    expect(update.transferredFromWindow).toBe(1);
  });

  it('취소 관계를 로컬 식별자로 잇는다', async () => {
    const tx = buildTx();
    await mirrorFolios(tx as never, 'res-1', 'KRW', [
      folio({
        balance: 0,
        postings: [
          {
            postingId: 'PST-801',
            type: 'Charge',
            transactionCode: '1000',
            description: '객실료',
            amount: 240000,
            currencyCode: 'KRW',
            postedAt: '2026-08-04T01:00:00.000Z',
            voidedById: 'PST-802',
          },
          {
            postingId: 'PST-802',
            type: 'Adjustment',
            transactionCode: '1000',
            description: '[취소] 객실료',
            amount: -240000,
            currencyCode: 'KRW',
            postedAt: '2026-08-04T01:05:00.000Z',
          },
        ],
      }),
    ]);

    expect(tx.posting.update).toHaveBeenCalledWith({
      where: { id: 'local-PST-801' },
      data: { voidedById: 'local-PST-802' },
    });
  });

  /*
   * 우리가 만들었다가 OPERA 가 받지 않은 행이 남으면 잔액과 내역이 어긋난다.
   * 로컬 원장을 OPERA 에 맞춘다.
   */
  it('OPERA 에 없는 거래는 지운다', async () => {
    const tx = buildTx();
    await mirrorFolios(tx as never, 'res-1', 'KRW', [folio()]);

    expect(tx.posting.deleteMany).toHaveBeenCalledWith({
      where: {
        folio: { reservationId: 'res-1', window: { in: [1] } },
        id: { notIn: ['local-PST-801'] },
      },
    });
  });

  it('거래가 하나도 없어도 남은 행을 지운다', async () => {
    const tx = buildTx();
    await mirrorFolios(tx as never, 'res-1', 'KRW', [folio({ balance: 0, postings: [] })]);

    const where = tx.posting.deleteMany.mock.calls[0][0].where;
    expect(where.id.notIn).toEqual(['-']);
  });

  it('통화가 비어 있으면 예약 통화를 쓴다', async () => {
    const tx = buildTx();
    await mirrorFolios(tx as never, 'res-1', 'USD', [folio({ currencyCode: '', postings: [] })]);

    expect(tx.folio.upsert.mock.calls[0][0].create.currency).toBe('USD');
  });

  it('금액은 Decimal 로 저장한다', async () => {
    const tx = buildTx();
    await mirrorFolios(tx as never, 'res-1', 'KRW', [folio()]);

    const create = tx.posting.upsert.mock.calls[0][0].create;
    expect(create.amount).toBeInstanceOf(Prisma.Decimal);
    expect(create.amount.toString()).toBe('240000');
  });
  /*
   * 사본의 고유 제약은 정합성 장치이지 업무 규칙이 아니다. 여기서 걸려 예외가
   * 나면 이미 돈이 오간 뒤에 500 이 떨어진다.
   */
  it('같은 식별자를 든 낡은 행에서 먼저 떼어 낸다', async () => {
    const tx = buildTx();
    await mirrorFolios(tx as never, 'res-1', 'KRW', [folio()]);

    expect(tx.folio.updateMany).toHaveBeenCalledWith({
      where: {
        operaFolioId: 'FOL-801',
        OR: [{ reservationId: { not: 'res-1' } }, { window: { not: 1 } }],
      },
      data: { operaFolioId: null },
    });
  });
});
