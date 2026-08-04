import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ArInvoiceStatus,
  ArTransactionType,
  Prisma,
  type ArAccount,
  type ArInvoice,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import { mirrorFolios } from '../folios/folio-mirror';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope, resolvePropertyScope } from '../properties/property-scope';
import type {
  CreateAccountDto,
  CreateInvoiceDto,
  ListAccountsDto,
  RecordArPaymentDto,
  TransferToArDto,
  UpdateAccountDto,
  UpdateInvoiceStatusDto,
} from './dto/ar.dto';

/** 폴리오에서 AR 로 넘길 때 쓰는 거래 코드. */
const AR_TRANSFER_CODE = '6000';

const ACCOUNT_INCLUDE = {
  profile: { select: { id: true, companyName: true, lastName: true, firstName: true } },
} satisfies Prisma.ArAccountInclude;

/**
 * AR / 시티레저 — 후불 거래처.
 *
 * 회사·여행사 앞으로 요금을 달아 두고 월말에 청구한다. 손님이 나갈 때 돈을
 * 받지 않으므로 그 금액은 폴리오에서 빠져나와 이 원장에 쌓인다.
 *
 * **이관은 폴리오에서 돈이 나간 것으로 기록한다.** OPERA 폴리오에 결제를 달아
 * 잔액을 0 으로 만들고, 같은 금액을 여기에 청구로 올린다. 폴리오만 비우고
 * 여기에 올리지 않으면 받을 돈이 사라지고, 여기만 올리고 폴리오를 두면 손님이
 * 체크아웃하지 못한다.
 *
 * 이 원장 자체는 우리가 들고 간다 — 폴리오는 OPERA 가 원천이지만, 거래처에
 * 언제 얼마를 청구했고 무엇이 미수인지는 호텔의 채권 관리다.
 */
@Injectable()
export class ArService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  // --- 거래처 -------------------------------------------------------------

  async listAccounts(query: ListAccountsDto, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, query.propertyId);

    const where: Prisma.ArAccountWhereInput = {
      ...(propertyId ? { propertyId } : {}),
      ...(query.includeInactive === 'true' ? {} : { active: true }),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: Prisma.QueryMode.insensitive } },
              { name: { contains: query.q, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };

    const accounts = await this.prisma.arAccount.findMany({
      where,
      include: ACCOUNT_INCLUDE,
      orderBy: { code: 'asc' },
    });

    const balances = await this.balancesFor(accounts.map((a) => a.id));
    return {
      items: accounts.map((account) => ({
        ...account,
        balance: balances.get(account.id) ?? '0.00',
      })),
      total: accounts.length,
    };
  }

  async createAccount(dto: CreateAccountDto, user: AuthUser): Promise<ArAccount> {
    const propertyId = resolvePropertyScope(user, dto.propertyId);
    if (!propertyId) {
      throw new BadRequestException('호텔을 선택해 주세요.');
    }

    const code = dto.code.trim().toUpperCase();
    const existing = await this.prisma.arAccount.findUnique({
      where: { propertyId_code: { propertyId, code } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`이미 있는 거래처 코드입니다: ${code}`);
    }

    return this.prisma.arAccount.create({
      data: {
        propertyId,
        code,
        name: dto.name.trim(),
        profileId: dto.profileId ?? null,
        creditLimit: dto.creditLimit === undefined ? null : new Prisma.Decimal(dto.creditLimit),
        termDays: dto.termDays ?? 30,
        billingEmail: dto.billingEmail ?? null,
        notes: dto.notes ?? null,
      },
      include: ACCOUNT_INCLUDE,
    });
  }

  async updateAccount(id: string, dto: UpdateAccountDto, user: AuthUser): Promise<ArAccount> {
    const account = await this.loadAccount(id, user);

    return this.prisma.arAccount.update({
      where: { id: account.id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
        ...(dto.creditLimit === undefined
          ? {}
          : { creditLimit: new Prisma.Decimal(dto.creditLimit) }),
        ...(dto.termDays === undefined ? {} : { termDays: dto.termDays }),
        ...(dto.billingEmail === undefined ? {} : { billingEmail: dto.billingEmail || null }),
        ...(dto.notes === undefined ? {} : { notes: dto.notes || null }),
        ...(dto.active === undefined ? {} : { active: dto.active === 'true' }),
      },
      include: ACCOUNT_INCLUDE,
    });
  }

  /** 거래처 상세 — 잔액과 최근 거래, 청구서. */
  async accountDetail(id: string, user: AuthUser) {
    const account = await this.loadAccount(id, user);

    const [transactions, invoices, balance, unbilled] = await Promise.all([
      this.prisma.arTransaction.findMany({
        where: { accountId: id },
        include: {
          invoice: { select: { id: true, number: true, status: true } },
          reservation: { select: { id: true, confirmationNumber: true } },
        },
        orderBy: { postedAt: 'desc' },
        take: 100,
      }),
      this.prisma.arInvoice.findMany({
        where: { accountId: id },
        orderBy: { issuedAt: 'desc' },
        take: 50,
      }),
      this.balanceOf(id),
      this.unbilledTotal(id),
    ]);

    return { account, balance, unbilled, transactions, invoices };
  }

  // --- 폴리오 → 거래처 -----------------------------------------------------

  /**
   * 폴리오 잔액을 거래처로 넘긴다.
   *
   * OPERA 폴리오에 결제를 달아 잔액을 0 으로 만들고, 같은 금액을 거래처
   * 원장에 청구로 올린다. 두 쪽이 함께 성립해야 하므로 OPERA 가 받아 준 뒤에만
   * 원장에 적는다.
   */
  async transferFolio(reservationId: string, dto: TransferToArDto, user: AuthUser) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { property: true, profile: true },
    });
    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${reservationId}`);
    }
    assertWithinScope(user, reservation.propertyId);

    if (!reservation.operaReservationId) {
      throw new BadRequestException(
        'OPERA 와 연결되지 않은 예약입니다. 먼저 동기화한 뒤 다시 시도해 주세요.',
      );
    }

    const account = await this.loadAccount(dto.accountId, user);
    if (account.propertyId !== reservation.propertyId) {
      throw new BadRequestException('다른 호텔의 거래처로는 넘길 수 없습니다.');
    }
    // 중지한 거래처로 넘기면 청구할 곳 없는 미수가 쌓인다.
    if (!account.active) {
      throw new BadRequestException(`중지된 거래처입니다: ${account.code}`);
    }

    const folio = await this.prisma.folio.findUnique({
      where: { reservationId_window: { reservationId, window: dto.window } },
    });
    if (!folio) {
      throw new NotFoundException(`윈도 ${dto.window} 이 열려 있지 않습니다.`);
    }
    if (folio.status === 'CLOSED') {
      throw new BadRequestException('마감된 폴리오는 넘길 수 없습니다.');
    }

    const amount = folio.balance;
    // 잔액이 없으면 넘길 것이 없고, 음수면 거래처가 아니라 손님에게 돌려줄 돈이다.
    if (amount.lessThanOrEqualTo(0)) {
      throw new BadRequestException(
        `넘길 잔액이 없습니다: ${amount.toString()}. 잔액이 남은 창구만 넘길 수 있습니다.`,
      );
    }

    /*
     * 여신 한도를 넘기면 막는다.
     *
     * 한도는 "이만큼까지는 받아 주겠다" 는 약속이다. 넘긴 뒤에 알면 이미 손님은
     * 나갔고 청구할 수 없는 금액이 남는다.
     */
    if (account.creditLimit) {
      const current = new Prisma.Decimal(await this.balanceOf(account.id));
      const after = current.add(amount);
      if (after.greaterThan(account.creditLimit)) {
        throw new BadRequestException(
          `여신 한도를 넘습니다. 한도 ${account.creditLimit.toString()}, 이관 후 ${after.toString()}`,
        );
      }
    }

    const description =
      dto.description?.trim() ||
      `${reservation.confirmationNumber ?? reservationId} 폴리오 이관 (윈도 ${dto.window})`;

    // 같은 창구를 두 번 넘기면 거래처에 두 배로 청구된다.
    const reference = `AR-${folio.id}`;

    const updatedFolio = await this.core.createPosting(reservation.operaReservationId, dto.window, {
      hotelId: reservation.property.operaHotelId,
      type: 'Payment',
      transactionCode: AR_TRANSFER_CODE,
      description: `[AR ${account.code}] ${description}`,
      amount: amount.toNumber(),
      reference,
    });

    return this.prisma.$transaction(async (tx) => {
      await mirrorFolios(tx, reservationId, reservation.currency, [updatedFolio]);

      const transaction = await tx.arTransaction.create({
        data: {
          accountId: account.id,
          type: ArTransactionType.CHARGE,
          amount,
          currency: folio.currency,
          description,
          reservationId,
          folioWindow: dto.window,
          createdById: user.id,
        },
      });

      return { transaction, folioBalance: updatedFolio.balance.toFixed(2) };
    });
  }

  /** 거래처 입금. 잔액에서 뺀다. */
  async recordPayment(accountId: string, dto: RecordArPaymentDto, user: AuthUser) {
    const account = await this.loadAccount(accountId, user);

    return this.prisma.arTransaction.create({
      data: {
        accountId: account.id,
        type: ArTransactionType.PAYMENT,
        // 입금은 음수로 올라간다. 잔액이 곧 거래 합계이기 때문이다.
        amount: new Prisma.Decimal(dto.amount).negated(),
        description: dto.description.trim(),
        createdById: user.id,
      },
    });
  }

  // --- 청구서 --------------------------------------------------------------

  /**
   * 미청구 거래를 모아 청구서를 만든다.
   *
   * 청구서에 묶인 거래는 다시 다른 청구서에 들어가지 않는다 — 두 번 청구하면
   * 거래처가 두 번 낸다.
   */
  async createInvoice(
    accountId: string,
    dto: CreateInvoiceDto,
    user: AuthUser,
  ): Promise<ArInvoice> {
    const account = await this.loadAccount(accountId, user);

    const unbilled = await this.prisma.arTransaction.findMany({
      where: { accountId, invoiceId: null, type: { not: ArTransactionType.PAYMENT } },
      select: { id: true, amount: true },
    });
    if (unbilled.length === 0) {
      throw new BadRequestException('청구할 거래가 없습니다.');
    }

    const total = unbilled.reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0));
    if (total.lessThanOrEqualTo(0)) {
      throw new BadRequestException(
        `청구 합계가 ${total.toString()} 입니다. 받을 금액이 있을 때만 청구서를 만듭니다.`,
      );
    }

    const number = dto.number?.trim() || (await this.nextInvoiceNumber(account.propertyId));
    const dueDate = dto.dueDate
      ? new Date(`${dto.dueDate}T00:00:00.000Z`)
      : addDays(new Date(), account.termDays);

    return this.prisma.$transaction(async (tx) => {
      const invoice = await tx.arInvoice.create({
        data: {
          propertyId: account.propertyId,
          accountId,
          number,
          total,
          currency: 'KRW',
          dueDate,
          note: dto.note ?? null,
          createdById: user.id,
        },
      });

      await tx.arTransaction.updateMany({
        where: { id: { in: unbilled.map((row) => row.id) } },
        data: { invoiceId: invoice.id },
      });

      return invoice;
    });
  }

  /**
   * 청구서 상태 변경.
   *
   * 무효로 돌리면 묶여 있던 거래를 풀어 준다 — 그러지 않으면 잘못 발행한
   * 청구서 때문에 그 거래를 영영 청구하지 못한다.
   */
  async updateInvoiceStatus(id: string, dto: UpdateInvoiceStatusDto, user: AuthUser) {
    const invoice = await this.prisma.arInvoice.findUnique({ where: { id } });
    if (!invoice) {
      throw new NotFoundException(`청구서를 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, invoice.propertyId);

    if (invoice.status === ArInvoiceStatus.VOID) {
      throw new ConflictException('무효 처리된 청구서는 되돌릴 수 없습니다.');
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      if (dto.status === ArInvoiceStatus.VOID) {
        await tx.arTransaction.updateMany({
          where: { invoiceId: id },
          data: { invoiceId: null },
        });
      }

      return tx.arInvoice.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.status === ArInvoiceStatus.SENT ? { sentAt: now } : {}),
          ...(dto.status === ArInvoiceStatus.PAID ? { paidAt: now } : {}),
          ...(dto.status === ArInvoiceStatus.VOID ? { voidedAt: now } : {}),
        },
      });
    });
  }

  async invoiceDetail(id: string, user: AuthUser) {
    const invoice = await this.prisma.arInvoice.findUnique({
      where: { id },
      include: {
        account: true,
        transactions: {
          include: { reservation: { select: { id: true, confirmationNumber: true } } },
          orderBy: { postedAt: 'asc' },
        },
      },
    });
    if (!invoice) {
      throw new NotFoundException(`청구서를 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, invoice.propertyId);
    return invoice;
  }

  // ---------------------------------------------------------------------------

  private async loadAccount(id: string, user: AuthUser): Promise<ArAccount> {
    const account = await this.prisma.arAccount.findUnique({
      where: { id },
      include: ACCOUNT_INCLUDE,
    });
    if (!account) {
      throw new NotFoundException(`거래처를 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, account.propertyId);
    return account;
  }

  /** 잔액은 저장하지 않는다. 거래 합계로 매번 다시 센다 — 폴리오와 같은 규칙이다. */
  private async balanceOf(accountId: string): Promise<string> {
    const total = await this.prisma.arTransaction.aggregate({
      where: { accountId },
      _sum: { amount: true },
    });
    return (total._sum.amount ?? new Prisma.Decimal(0)).toFixed(2);
  }

  private async balancesFor(accountIds: string[]): Promise<Map<string, string>> {
    if (accountIds.length === 0) return new Map();

    const rows = await this.prisma.arTransaction.groupBy({
      by: ['accountId'],
      where: { accountId: { in: accountIds } },
      _sum: { amount: true },
    });

    return new Map(
      rows.map((row) => [row.accountId, (row._sum.amount ?? new Prisma.Decimal(0)).toFixed(2)]),
    );
  }

  /**
   * 아직 청구서에 묶이지 않은 금액. 다음 청구서에 들어갈 몫이다.
   *
   * 입금은 세지 않는다 — 입금은 청구하는 것이 아니라 청구한 것을 갚는 것이다.
   * 함께 세면 다음 달 청구서가 지난달 입금만큼 깎여 거래처가 그만큼 덜 낸다.
   */
  private async unbilledTotal(accountId: string): Promise<string> {
    const total = await this.prisma.arTransaction.aggregate({
      where: { accountId, invoiceId: null, type: { not: ArTransactionType.PAYMENT } },
      _sum: { amount: true },
    });
    return (total._sum.amount ?? new Prisma.Decimal(0)).toFixed(2);
  }

  /**
   * 다음 청구서 번호.
   *
   * 호텔별로 연도-일련번호를 매긴다. 거래처와 주고받는 식별자라 사람이 읽을 수
   * 있어야 하고, 호텔이 다르면 번호가 겹쳐도 상관없다.
   */
  private async nextInvoiceNumber(propertyId: string): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `INV-${year}-`;

    const last = await this.prisma.arInvoice.findFirst({
      where: { propertyId, number: { startsWith: prefix } },
      orderBy: { number: 'desc' },
      select: { number: true },
    });

    const sequence = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(sequence).padStart(4, '0')}`;
  }
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + days);
  return new Date(next.toISOString().slice(0, 10) + 'T00:00:00.000Z');
}
