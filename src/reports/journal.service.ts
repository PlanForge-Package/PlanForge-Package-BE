import { Injectable } from '@nestjs/common';
import { PaymentStatus, PostingType, Prisma, type Property } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CoreTransactionCode } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePropertyScope } from '../properties/property-scope';
import { parseDateOnly } from '../sync/reservation.mapper';
import type { JournalDto } from './dto/reports.dto';
import { badRequest, notFound } from '../common/errors';

/** Revenue group labels. Groups absent from the code setup are shown as they are. */
const GROUP_LABELS: Record<string, string> = {
  Room: '객실',
  FoodBeverage: '식음',
  Other: '기타',
  Payment: '결제',
};

/** Payment states counted as money received. An authorisation is not ours yet. */
const SETTLED: PaymentStatus[] = [PaymentStatus.CAPTURED, PaymentStatus.REFUNDED];

const ZERO = new Prisma.Decimal(0);

interface CodeRow {
  transactionCode: string;
  name: string;
  group: string;
  count: number;
  gross: Prisma.Decimal;
  net: Prisma.Decimal;
  serviceCharge: Prisma.Decimal;
  vat: Prisma.Decimal;
  /** A code missing from the transaction code setup. A person has to place it. */
  unmapped: boolean;
}

/**
 * Accounting close journal.
 *
 * Sums the day's folio postings by transaction code and splits the displayed price
 * into net, service charge and VAT. Korean hotels sell tax-inclusive prices, so
 * dividing rather than adding is right — adding would make the charge differ from
 * the amount quoted to the guest.
 *
 * The basis for classification (revenue group and tax rates) is OPERA's transaction
 * code setup. Our own table would split the two closes whenever OPERA changes a rate.
 *
 * This report is computed from the local copy. Official figures for tax filing must
 * follow OPERA's close reports — these are for checking the day's money.
 */
@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  async daily(query: JournalDto, user: AuthUser) {
    const property = await this.resolveProperty(query.propertyId, user);

    const date = query.date;
    const dayStart = parseDateOnly(date);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const [codes, postings, payments, opening] = await Promise.all([
      this.loadCodes(property),
      this.prisma.posting.findMany({
        where: {
          propertyId: property.id,
          postedAt: { gte: dayStart, lt: dayEnd },
        },
        select: { transactionCode: true, type: true, amount: true },
      }),
      this.prisma.payment.findMany({
        where: {
          propertyId: property.id,
          status: { in: SETTLED },
          capturedAt: { gte: dayStart, lt: dayEnd },
        },
        select: { method: true, amount: true, refundedAmount: true },
      }),
      // Balance carried in from the previous day. The sum of postings is what is owed.
      this.prisma.posting.aggregate({
        where: {
          propertyId: property.id,
          postedAt: { lt: dayStart },
        },
        _sum: { amount: true },
      }),
    ]);

    const byCode = new Map<string, CodeRow>();
    let chargeTotal = ZERO;
    let paymentTotal = ZERO;

    for (const posting of postings) {
      const amount = posting.amount;

      // Payments are not revenue. Left unsplit, revenue drops by the payments.
      if (posting.type === PostingType.PAYMENT) {
        paymentTotal = paymentTotal.add(amount.negated());
        continue;
      }
      chargeTotal = chargeTotal.add(amount);

      const config = codes.get(posting.transactionCode);
      const row = byCode.get(posting.transactionCode) ?? {
        transactionCode: posting.transactionCode,
        name: config?.name ?? '(설정 없음)',
        group: config?.group ?? 'Other',
        count: 0,
        gross: ZERO,
        net: ZERO,
        serviceCharge: ZERO,
        vat: ZERO,
        unmapped: !config,
      };

      const split = decompose(amount, config);
      row.count += 1;
      row.gross = row.gross.add(amount);
      row.net = row.net.add(split.net);
      row.serviceCharge = row.serviceCharge.add(split.serviceCharge);
      row.vat = row.vat.add(split.vat);
      byCode.set(posting.transactionCode, row);
    }

    const rows = [...byCode.values()].sort((a, b) =>
      a.transactionCode.localeCompare(b.transactionCode),
    );

    const groups = new Map<string, CodeRow[]>();
    for (const row of rows) {
      groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
    }

    const openingBalance = opening._sum.amount ?? ZERO;
    const closingBalance = openingBalance.add(chargeTotal).sub(paymentTotal);

    /*
     * Reconciliation.
     *
     * The computed closing balance must equal the sum of open folio balances. A
     * difference means postings are leaking somewhere, so it is stated as a number.
     */
    const openFolios = await this.prisma.folio.aggregate({
      where: { reservation: { propertyId: property.id }, status: 'OPEN' },
      _sum: { balance: true },
    });
    const outstanding = openFolios._sum.balance ?? ZERO;

    const paymentsByMethod = new Map<string, { count: number; amount: Prisma.Decimal }>();
    for (const payment of payments) {
      const current = paymentsByMethod.get(payment.method) ?? { count: 0, amount: ZERO };
      // Refunded amounts are not money received.
      const net = payment.amount.sub(payment.refundedAmount);
      paymentsByMethod.set(payment.method, {
        count: current.count + 1,
        amount: current.amount.add(net),
      });
    }

    return {
      propertyId: property.id,
      date,
      revenue: {
        groups: [...groups.entries()].map(([group, items]) => ({
          group,
          label: GROUP_LABELS[group] ?? group,
          count: items.reduce((sum, row) => sum + row.count, 0),
          gross: sum(items, 'gross').toFixed(2),
          net: sum(items, 'net').toFixed(2),
          serviceCharge: sum(items, 'serviceCharge').toFixed(2),
          vat: sum(items, 'vat').toFixed(2),
          codes: items.map(serialize),
        })),
        total: {
          count: rows.reduce((total, row) => total + row.count, 0),
          gross: sum(rows, 'gross').toFixed(2),
          net: sum(rows, 'net').toFixed(2),
          serviceCharge: sum(rows, 'serviceCharge').toFixed(2),
          vat: sum(rows, 'vat').toFixed(2),
        },
      },
      unmappedCodes: rows.filter((row) => row.unmapped).map((row) => row.transactionCode),
      payments: {
        methods: [...paymentsByMethod.entries()].map(([method, row]) => ({
          method,
          count: row.count,
          amount: row.amount.toFixed(2),
        })),
        total: [...paymentsByMethod.values()]
          .reduce((total, row) => total.add(row.amount), ZERO)
          .toFixed(2),
      },
      ledger: {
        openingBalance: openingBalance.toFixed(2),
        charges: chargeTotal.toFixed(2),
        payments: paymentTotal.toFixed(2),
        closingBalance: closingBalance.toFixed(2),
        /** Sum of open folio balances. Must match the closing balance. */
        outstanding: outstanding.toFixed(2),
        balanced: closingBalance.equals(outstanding),
      },
    };
  }

  /** Transaction code setup. Inactive codes too — past closes still carry them. */
  private async loadCodes(property: Property): Promise<Map<string, CoreTransactionCode>> {
    const result = await this.core.listTransactionCodes(property.operaHotelId, true);
    return new Map(result.items.map((row) => [row.transactionCode, row]));
  }

  private async resolveProperty(requested: string | undefined, user: AuthUser): Promise<Property> {
    const propertyId = resolvePropertyScope(user, requested);
    if (!propertyId) {
      throw badRequest('PROPERTY_REQUIRED');
    }

    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw notFound('PROPERTY_NOT_FOUND', { propertyId: propertyId });
    }
    return property;
  }
}

function sum(rows: CodeRow[], field: 'gross' | 'net' | 'serviceCharge' | 'vat'): Prisma.Decimal {
  return rows.reduce((total, row) => total.add(row[field]), ZERO);
}

function serialize(row: CodeRow) {
  return {
    transactionCode: row.transactionCode,
    name: row.name,
    group: row.group,
    count: row.count,
    gross: row.gross.toFixed(2),
    net: row.net.toFixed(2),
    serviceCharge: row.serviceCharge.toFixed(2),
    vat: row.vat.toFixed(2),
    unmapped: row.unmapped,
  };
}

/**
 * Splits a displayed price into net, service charge and VAT.
 *
 * Service charge applies first and VAT applies to that sum, so unwinding follows
 * the same order in reverse: gross = net × (1+svc) × (1+vat).
 *
 * Rounding all three separately makes them miss the original. VAT is derived by
 * subtraction so the parts always sum to the gross — a single won off breaks the close.
 */
function decompose(
  gross: Prisma.Decimal,
  config: CoreTransactionCode | undefined,
): { net: Prisma.Decimal; serviceCharge: Prisma.Decimal; vat: Prisma.Decimal } {
  // Codes with no setup or with tax excluded are not split. Splitting invents tax.
  if (!config || !config.taxInclusive || (config.vatRate === 0 && config.serviceChargeRate === 0)) {
    return { net: gross, serviceCharge: ZERO, vat: ZERO };
  }

  const svcRate = new Prisma.Decimal(config.serviceChargeRate);
  const vatRate = new Prisma.Decimal(config.vatRate);
  const divisor = new Prisma.Decimal(1).add(svcRate).mul(new Prisma.Decimal(1).add(vatRate));

  const net = gross.div(divisor).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  const serviceCharge = net.mul(svcRate).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  const vat = gross.sub(net).sub(serviceCharge);

  return { net, serviceCharge, vat };
}
