import { Injectable } from '@nestjs/common';
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
import { badRequest, conflict, notFound } from '../common/errors';

/** Payment states in the closing totals. An authorisation is not money received yet. */
const SETTLED: PaymentStatus[] = [PaymentStatus.CAPTURED, PaymentStatus.REFUNDED];

const SHIFT_INCLUDE = {
  user: { select: { id: true, name: true, role: true } },
} satisfies Prisma.CashierShiftInclude;

/**
 * Cashier shift close.
 *
 * The front desk takes money in shifts. Without recording who took how much per
 * shift, a cash discrepancy leaves nobody to ask and no window to look at.
 *
 * The money itself is already on the OPERA folio. What is handled here is only the
 * gap between **what should be in the drawer and what actually was**. Shifts are
 * our own staff scheduling, so they do not go to OPERA — as with housekeeping.
 */
@Injectable()
export class CashierService {
  constructor(private readonly prisma: PrismaService) {}

  /** My currently open shift, or null. */
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
   * Opens a shift.
   *
   * One person cannot hold two open shifts. With two, there is no telling which
   * shift a receipt belongs to and the closing amount splits across both.
   */
  async open(dto: OpenShiftDto, user: AuthUser): Promise<CashierShift> {
    const propertyId = resolvePropertyScope(user, dto.propertyId);
    if (!propertyId) {
      throw badRequest('PROPERTY_REQUIRED');
    }

    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw notFound('PROPERTY_NOT_FOUND', { propertyId: propertyId });
    }

    const open = await this.prisma.cashierShift.findFirst({
      where: { userId: user.id, closedAt: null },
      select: { id: true, propertyId: true },
    });
    if (open) {
      throw conflict('SHIFT_ALREADY_OPEN');
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
   * Close.
   *
   * Records the gap between counted and expected cash. A gap does not block the
   * close — blocking it means nobody closes until it balances, and the next shift's
   * receipts mix in. Better recorded openly and checked the next day.
   */
  async close(id: string, dto: CloseShiftDto, user: AuthUser) {
    const shift = await this.prisma.cashierShift.findUnique({
      where: { id },
      include: SHIFT_INCLUDE,
    });
    if (!shift) {
      throw notFound('SHIFT_NOT_FOUND', { id: id });
    }
    assertWithinScope(user, shift.propertyId);

    // Closing someone else's shift denies them the chance to check what they took.
    if (shift.userId !== user.id) {
      throw badRequest('SHIFT_NOT_MINE');
    }
    if (shift.closedAt) {
      throw conflict('SHIFT_ALREADY_CLOSED');
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

  /** Past shifts. Used to trace back a shift that came up short. */
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
      throw notFound('SHIFT_NOT_FOUND', { id: id });
    }
    assertWithinScope(user, shift.propertyId);

    return { shift, summary: await this.summarize(shift) };
  }

  // ---------------------------------------------------------------------------

  /**
   * Receipts totalled per shift.
   *
   * Refunds are subtracted from money received, since that much left the drawer.
   * Authorised-only cards are excluded — before capture it is not our money yet.
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
    /** Cash that should be in the drawer: the opening float plus this shift's cash. */
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
      /** Counted minus expected. Positive is over, negative is short. */
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

/** What actually remains in the drawer. Refunds have already left it. */
function net(payment: Pick<Payment, 'amount' | 'refundedAmount'>): Prisma.Decimal {
  return payment.amount.sub(payment.refundedAmount);
}
