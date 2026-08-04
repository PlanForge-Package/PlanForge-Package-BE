import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  type CashierShift,
  type Payment,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope, resolvePropertyScope } from '../properties/property-scope';
import type { CloseShiftDto, ListShiftsDto, OpenShiftDto } from './dto/cashier.dto';

/** 마감 집계에 들어가는 결제 상태. 승인만 된 건은 아직 받은 돈이 아니다. */
const SETTLED: PaymentStatus[] = [PaymentStatus.CAPTURED, PaymentStatus.REFUNDED];

const SHIFT_INCLUDE = {
  user: { select: { id: true, name: true, role: true } },
} satisfies Prisma.CashierShiftInclude;

/**
 * 캐셔 근무조 마감.
 *
 * 프런트는 교대로 돈을 받는다. 누가 얼마를 받았는지 조별로 끊어 두지 않으면
 * 현금이 맞지 않을 때 어느 시간대의 누구를 봐야 하는지 알 수 없다.
 *
 * 돈 자체는 이미 OPERA 폴리오에 올라가 있다. 여기서 다루는 것은 **금고에 얼마가
 * 있어야 하는가와 실제로 얼마가 있었는가**의 차이뿐이다. 근무 편성은 우리
 * 직원의 일이라 OPERA 에 보내지 않는다 — 하우스키핑 배정과 같은 이유다.
 */
@Injectable()
export class CashierService {
  constructor(private readonly prisma: PrismaService) {}

  /** 지금 열려 있는 내 근무조. 없으면 null 이다. */
  async current(user: AuthUser) {
    const shift = await this.prisma.cashierShift.findFirst({
      where: { userId: user.id, closedAt: null },
      include: SHIFT_INCLUDE,
      orderBy: { openedAt: 'desc' },
    });

    if (!shift) return { shift: null, summary: null };
    return { shift, summary: await this.summarize(shift) };
  }

  /**
   * 근무조를 연다.
   *
   * 한 사람이 두 조를 동시에 열 수 없다. 열려 있으면 수납이 어느 조에 붙는지
   * 정할 수 없고, 마감 금액이 두 조로 나뉜다.
   */
  async open(dto: OpenShiftDto, user: AuthUser): Promise<CashierShift> {
    const propertyId = resolvePropertyScope(user, dto.propertyId);
    if (!propertyId) {
      throw new BadRequestException('호텔을 선택해 주세요.');
    }

    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw new NotFoundException(`호텔을 찾을 수 없습니다: ${propertyId}`);
    }

    const open = await this.prisma.cashierShift.findFirst({
      where: { userId: user.id, closedAt: null },
      select: { id: true, propertyId: true },
    });
    if (open) {
      throw new ConflictException('이미 열려 있는 근무조가 있습니다. 먼저 마감해 주세요.');
    }

    return this.prisma.cashierShift.create({
      data: {
        propertyId,
        userId: user.id,
        openingFloat: new Prisma.Decimal(dto.openingFloat ?? 0),
      },
      include: SHIFT_INCLUDE,
    });
  }

  /**
   * 마감.
   *
   * 센 현금과 있어야 할 현금의 차이를 남긴다. 차이가 나도 마감을 막지 않는다 —
   * 막으면 맞을 때까지 아무도 마감하지 않고, 다음 조의 수납이 이 조에 섞인다.
   * 차이는 숨기지 말고 기록해서 다음 날 확인하게 하는 편이 낫다.
   */
  async close(id: string, dto: CloseShiftDto, user: AuthUser) {
    const shift = await this.prisma.cashierShift.findUnique({
      where: { id },
      include: SHIFT_INCLUDE,
    });
    if (!shift) {
      throw new NotFoundException(`근무조를 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, shift.propertyId);

    // 남의 조를 마감하면 그 사람은 자기가 받은 돈을 확인할 기회를 잃는다.
    if (shift.userId !== user.id) {
      throw new BadRequestException('자기 근무조만 마감할 수 있습니다.');
    }
    if (shift.closedAt) {
      throw new ConflictException('이미 마감된 근무조입니다.');
    }

    const closed = await this.prisma.cashierShift.update({
      where: { id },
      data: {
        closedAt: new Date(),
        countedCash: new Prisma.Decimal(dto.countedCash),
        ...(dto.notes ? { notes: dto.notes } : {}),
      },
      include: SHIFT_INCLUDE,
    });

    return { shift: closed, summary: await this.summarize(closed) };
  }

  /** 지난 근무조. 차이가 났던 조를 되짚을 때 쓴다. */
  async list(query: ListShiftsDto, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, query.propertyId);

    const items = await this.prisma.cashierShift.findMany({
      where: { ...(propertyId ? { propertyId } : {}) },
      include: SHIFT_INCLUDE,
      orderBy: { openedAt: 'desc' },
      take: query.limit ?? 20,
    });

    const summaries = await Promise.all(items.map((shift) => this.summarize(shift)));
    return {
      items: items.map((shift, index) => ({ ...shift, summary: summaries[index] })),
      total: items.length,
    };
  }

  async detail(id: string, user: AuthUser) {
    const shift = await this.prisma.cashierShift.findUnique({
      where: { id },
      include: SHIFT_INCLUDE,
    });
    if (!shift) {
      throw new NotFoundException(`근무조를 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, shift.propertyId);

    return { shift, summary: await this.summarize(shift) };
  }

  // ---------------------------------------------------------------------------

  /**
   * 조별 수납 집계.
   *
   * 환불은 받은 돈에서 빼고 센다. 환불한 만큼 금고에서 나갔기 때문이다.
   * 승인만 된 카드는 넣지 않는다 — 매입 전에는 아직 우리 돈이 아니다.
   */
  private async summarize(shift: CashierShift) {
    const payments = await this.prisma.payment.findMany({
      where: { shiftId: shift.id, status: { in: SETTLED } },
      select: { method: true, amount: true, refundedAmount: true },
    });

    const byMethod = this.emptyTotals();
    for (const payment of payments) {
      byMethod[payment.method] = byMethod[payment.method].add(net(payment));
    }

    const cash = byMethod[PaymentMethod.CASH];
    const openingFloat = shift.openingFloat;
    /** 금고에 있어야 할 현금. 시작 시재에 이 조가 받은 현금을 더한 값이다. */
    const expectedCash = openingFloat.add(cash);
    const countedCash = shift.countedCash;

    return {
      openingFloat: openingFloat.toFixed(2),
      byMethod: {
        CASH: byMethod.CASH.toFixed(2),
        CARD: byMethod.CARD.toFixed(2),
        TRANSFER: byMethod.TRANSFER.toFixed(2),
      },
      collected: byMethod.CASH.add(byMethod.CARD).add(byMethod.TRANSFER).toFixed(2),
      expectedCash: expectedCash.toFixed(2),
      countedCash: countedCash ? countedCash.toFixed(2) : null,
      /** 센 것 − 있어야 할 것. 양수면 과잉, 음수면 부족이다. */
      difference: countedCash ? countedCash.sub(expectedCash).toFixed(2) : null,
      paymentCount: payments.length,
    };
  }

  private emptyTotals(): Record<PaymentMethod, Prisma.Decimal> {
    return {
      [PaymentMethod.CASH]: new Prisma.Decimal(0),
      [PaymentMethod.CARD]: new Prisma.Decimal(0),
      [PaymentMethod.TRANSFER]: new Prisma.Decimal(0),
    };
  }
}

/** 실제로 금고에 남은 금액. 환불한 만큼은 나갔다. */
function net(payment: Pick<Payment, 'amount' | 'refundedAmount'>): Prisma.Decimal {
  return payment.amount.sub(payment.refundedAmount);
}
