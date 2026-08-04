import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentStatus, PostingType, Prisma, type Property } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CoreTransactionCode } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePropertyScope } from '../properties/property-scope';
import { parseDateOnly } from '../sync/reservation.mapper';
import type { JournalDto } from './dto/reports.dto';

/** 매출 그룹 표기. 코드 설정에 없는 그룹은 그대로 보여 준다. */
const GROUP_LABELS: Record<string, string> = {
  Room: '객실',
  FoodBeverage: '식음',
  Other: '기타',
  Payment: '결제',
};

/** 실제로 받은 돈으로 세는 결제 상태. 승인만 된 카드는 아직 우리 돈이 아니다. */
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
  /** 거래 코드 설정에 없는 코드. 어디로 분개할지 사람이 정해야 한다. */
  unmapped: boolean;
}

/**
 * 회계 마감 분개.
 *
 * 그날 폴리오에 올라간 금액을 거래 코드별로 모으고, 표시가격에서 공급가액·
 * 봉사료·부가세를 갈라낸다. 국내 호텔은 세금을 포함한 값으로 팔기 때문에
 * 세금을 따로 더하지 않고 나누는 것이 맞다 — 더하면 손님에게 안내한 금액과
 * 청구가 달라진다.
 *
 * 분류의 기준(매출 그룹·세율)은 OPERA 의 거래 코드 설정이다. 우리가 따로 표를
 * 들고 있으면 OPERA 에서 세율을 고쳤을 때 두 시스템의 마감이 갈린다.
 *
 * 이 리포트는 로컬 사본에서 계산한 값이다. 세무 신고에 쓰는 공식 수치는 OPERA 의
 * 마감 리포트를 따라야 한다 — 여기 값은 그날의 돈이 맞는지 보기 위한 것이다.
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
          folio: { reservation: { propertyId: property.id } },
          postedAt: { gte: dayStart, lt: dayEnd },
        },
        select: { transactionCode: true, type: true, amount: true },
      }),
      this.prisma.payment.findMany({
        where: {
          folio: { reservation: { propertyId: property.id } },
          status: { in: SETTLED },
          capturedAt: { gte: dayStart, lt: dayEnd },
        },
        select: { method: true, amount: true, refundedAmount: true },
      }),
      // 전일까지 쌓인 잔액. 포스팅 합계가 곧 미수다.
      this.prisma.posting.aggregate({
        where: {
          folio: { reservation: { propertyId: property.id } },
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

      // 결제는 매출이 아니다. 분개에서 갈라 두지 않으면 매출이 결제만큼 깎인다.
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
     * 대사.
     *
     * 계산한 마감 잔액과 실제 열린 폴리오 잔액의 합이 같아야 한다. 다르면 어딘가
     * 포스팅이 새고 있다는 뜻이라, 그 사실을 숫자로 드러내 둔다.
     */
    const openFolios = await this.prisma.folio.aggregate({
      where: { reservation: { propertyId: property.id }, status: 'OPEN' },
      _sum: { balance: true },
    });
    const outstanding = openFolios._sum.balance ?? ZERO;

    const paymentsByMethod = new Map<string, { count: number; amount: Prisma.Decimal }>();
    for (const payment of payments) {
      const current = paymentsByMethod.get(payment.method) ?? { count: 0, amount: ZERO };
      // 환불한 만큼은 받은 돈이 아니다.
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
        /** 열린 폴리오 잔액의 합. 마감 잔액과 같아야 한다. */
        outstanding: outstanding.toFixed(2),
        balanced: closingBalance.equals(outstanding),
      },
    };
  }

  /** 거래 코드 설정. 중지한 코드도 읽는다 — 지난 마감에는 그 코드가 남아 있다. */
  private async loadCodes(property: Property): Promise<Map<string, CoreTransactionCode>> {
    const result = await this.core.listTransactionCodes(property.operaHotelId, true);
    return new Map(result.items.map((row) => [row.transactionCode, row]));
  }

  private async resolveProperty(requested: string | undefined, user: AuthUser): Promise<Property> {
    const propertyId = resolvePropertyScope(user, requested);
    if (!propertyId) {
      throw new BadRequestException('호텔을 선택해 주세요.');
    }

    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw new NotFoundException(`호텔을 찾을 수 없습니다: ${propertyId}`);
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
 * 표시가격을 공급가액·봉사료·부가세로 나눈다.
 *
 * 봉사료가 먼저 붙고 그 합에 부가세가 붙는다. 그래서 거꾸로 풀 때도 같은 순서를
 * 거슬러 올라간다: gross = net × (1+봉사료율) × (1+부가세율).
 *
 * 세 값을 각자 반올림하면 합이 원래 금액과 어긋난다. 부가세는 빼기로 맞춰
 * 합계가 항상 표시가격과 같게 둔다 — 1원이라도 어긋나면 마감이 안 맞는다.
 */
function decompose(
  gross: Prisma.Decimal,
  config: CoreTransactionCode | undefined,
): { net: Prisma.Decimal; serviceCharge: Prisma.Decimal; vat: Prisma.Decimal } {
  // 설정이 없거나 세금이 별도인 코드는 나누지 않는다. 나누면 없는 세금을 지어낸다.
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
