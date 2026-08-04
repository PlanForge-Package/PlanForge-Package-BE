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
  AgingDto,
  CreateAccountDto,
  CreateInvoiceDto,
  ListAccountsDto,
  RecordArPaymentDto,
  TransferToArDto,
  UpdateAccountDto,
  UpdateInvoiceStatusDto,
} from './dto/ar.dto';

/** Transaction code used when transferring a folio to AR. */
const AR_TRANSFER_CODE = '6000';

const ACCOUNT_INCLUDE = {
  profile: { select: { id: true, companyName: true, lastName: true, firstName: true } },
} satisfies Prisma.ArAccountInclude;

/**
 * AR / city ledger — direct-bill accounts.
 *
 * Charges are billed to a company or agency and invoiced at month end. No money
 * is taken at departure, so the amount leaves the folio and lands in this ledger.
 *
 * **A transfer is recorded as money leaving the folio.** A payment is posted on
 * the OPERA folio to bring it to zero and the same amount is raised here as a
 * charge. Emptying only the folio loses the receivable; raising only here leaves
 * the guest unable to check out.
 *
 * We own the ledger itself — folios come from OPERA, but when and how much we
 * billed an account, and what is outstanding, is the hotel's receivables management.
 */
@Injectable()
export class ArService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  // --- Accounts -----------------------------------------------------------

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

  /** Account detail — balance, recent transactions and invoices. */
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
        include: { allocations: { select: { amount: true } } },
        orderBy: { issuedAt: 'desc' },
        take: 50,
      }),
      this.balanceOf(id),
      this.unbilledTotal(id),
    ]);

    const today = new Date().toISOString().slice(0, 10);

    return {
      account,
      balance,
      unbilled,
      transactions,
      // Received and outstanding per invoice. A total alone cannot say who to chase.
      invoices: invoices.map((invoice) => {
        const paid = invoice.allocations.reduce(
          (sum, row) => sum.add(row.amount),
          new Prisma.Decimal(0),
        );
        const outstanding = invoice.total.sub(paid);
        const dueDate = invoice.dueDate.toISOString().slice(0, 10);
        return {
          ...invoice,
          paid: paid.toFixed(2),
          outstanding: outstanding.toFixed(2),
          overdue:
            invoice.status !== ArInvoiceStatus.PAID &&
            invoice.status !== ArInvoiceStatus.VOID &&
            outstanding.greaterThan(0) &&
            dueDate < today,
        };
      }),
    };
  }

  // --- Folio to account ----------------------------------------------------

  /**
   * Transfers a folio balance to an account.
   *
   * A payment is posted on the OPERA folio to bring it to zero and the same
   * amount is raised as a charge on the account ledger. Both must hold, so the
   * ledger is written only after OPERA accepts.
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
    // Transferring to a suspended account piles up receivables with nobody to bill.
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
    // Nothing to transfer at zero; a negative balance is owed back to the guest.
    if (amount.lessThanOrEqualTo(0)) {
      throw new BadRequestException(
        `넘길 잔액이 없습니다: ${amount.toString()}. 잔액이 남은 창구만 넘길 수 있습니다.`,
      );
    }

    /*
     * Blocked once the credit limit is exceeded.
     *
     * The limit is a promise of how much we will carry. Finding out afterwards
     * means the guest has left and the amount cannot be billed.
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

    // Transferring one window twice bills the account twice.
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

  /**
   * Account payment. Subtracted from the balance.
   *
   * An account may split one invoice across payments or settle several at once.
   * Without recording how much went to which invoice we cannot say what to chase,
   * and end up asking again for money already received.
   */
  async recordPayment(accountId: string, dto: RecordArPaymentDto, user: AuthUser) {
    const account = await this.loadAccount(accountId, user);
    const amount = new Prisma.Decimal(dto.amount);

    const requested = dto.allocations ?? [];
    if (requested.length > 0 && dto.autoApply === 'true') {
      throw new BadRequestException(
        '자동 배분과 직접 배분을 함께 쓸 수 없습니다. 하나만 골라 주세요.',
      );
    }

    // Open invoices and what they still owe. Allocation happens only within these.
    const open = await this.openInvoices(account.id);
    const outstanding = new Map(open.map((row) => [row.invoice.id, row.outstanding]));

    let plan: Array<{ invoiceId: string; amount: Prisma.Decimal }>;
    if (dto.autoApply === 'true') {
      plan = this.autoAllocate(open, amount);
    } else {
      plan = requested.map((row) => ({
        invoiceId: row.invoiceId,
        amount: new Prisma.Decimal(row.amount),
      }));

      for (const row of plan) {
        const left = outstanding.get(row.invoiceId);
        if (left === undefined) {
          throw new BadRequestException(
            `이 거래처의 청구서가 아니거나 이미 정리된 청구서입니다: ${row.invoiceId}`,
          );
        }
        if (row.amount.greaterThan(left)) {
          throw new BadRequestException(
            `청구서에 남은 금액보다 많이 붙일 수 없습니다. 남은 금액 ${left.toString()}, 붙이려는 금액 ${row.amount.toString()}`,
          );
        }
      }

      const seen = new Set(plan.map((row) => row.invoiceId));
      if (seen.size !== plan.length) {
        throw new BadRequestException('같은 청구서를 두 번 지정했습니다.');
      }
    }

    const allocated = plan.reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0));
    // Allocating more than was received clears invoices with money we never got.
    if (allocated.greaterThan(amount)) {
      throw new BadRequestException(
        `입금액보다 많이 배분할 수 없습니다. 입금 ${amount.toString()}, 배분 ${allocated.toString()}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.arTransaction.create({
        data: {
          accountId: account.id,
          type: ArTransactionType.PAYMENT,
          // Payments post negative, because the balance is the sum of transactions.
          amount: amount.negated(),
          description: dto.description.trim(),
          createdById: user.id,
        },
      });

      for (const row of plan) {
        if (row.amount.lessThanOrEqualTo(0)) continue;
        await tx.arAllocation.create({
          data: {
            invoiceId: row.invoiceId,
            paymentId: payment.id,
            amount: row.amount,
            createdById: user.id,
          },
        });

        // A fully covered invoice moves to PAID. Anything left stays as it is.
        const left = (outstanding.get(row.invoiceId) ?? new Prisma.Decimal(0)).sub(row.amount);
        if (left.lessThanOrEqualTo(0)) {
          await tx.arInvoice.update({
            where: { id: row.invoiceId },
            data: { status: ArInvoiceStatus.PAID, paidAt: new Date() },
          });
        }
      }

      return {
        payment,
        allocations: plan.map((row) => ({
          invoiceId: row.invoiceId,
          amount: row.amount.toFixed(2),
        })),
        unapplied: amount.sub(allocated).toFixed(2),
      };
    });
  }

  /**
   * Aging.
   *
   * Groups overdue invoices by account and by how long they are past due. Older
   * receivables are harder to collect, and a total alone hides where to start.
   */
  async aging(query: AgingDto, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, query.propertyId);
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const asOfDate = new Date(`${asOf}T00:00:00.000Z`);

    const invoices = await this.prisma.arInvoice.findMany({
      where: {
        ...(propertyId ? { propertyId } : {}),
        status: { notIn: [ArInvoiceStatus.PAID, ArInvoiceStatus.VOID] },
      },
      include: {
        account: { select: { id: true, code: true, name: true, billingEmail: true } },
        allocations: { select: { amount: true } },
      },
      orderBy: { dueDate: 'asc' },
    });

    const buckets = ['current', 'days30', 'days60', 'days90', 'over90'] as const;
    type Bucket = (typeof buckets)[number];

    const accounts = new Map<
      string,
      {
        account: (typeof invoices)[number]['account'];
        total: Prisma.Decimal;
        overdue: Prisma.Decimal;
        buckets: Record<Bucket, Prisma.Decimal>;
        invoices: Array<{
          id: string;
          number: string;
          dueDate: string;
          status: string;
          total: string;
          paid: string;
          outstanding: string;
          daysOverdue: number;
        }>;
      }
    >();

    for (const invoice of invoices) {
      const paid = invoice.allocations.reduce(
        (sum, row) => sum.add(row.amount),
        new Prisma.Decimal(0),
      );
      const outstanding = invoice.total.sub(paid);
      // Status can lag behind a fully paid invoice. Drop it when nothing is left.
      if (outstanding.lessThanOrEqualTo(0)) continue;

      const daysOverdue = Math.floor((asOfDate.getTime() - invoice.dueDate.getTime()) / 86_400_000);
      const bucket: Bucket =
        daysOverdue <= 0
          ? 'current'
          : daysOverdue <= 30
            ? 'days30'
            : daysOverdue <= 60
              ? 'days60'
              : daysOverdue <= 90
                ? 'days90'
                : 'over90';

      const row = accounts.get(invoice.accountId) ?? {
        account: invoice.account,
        total: new Prisma.Decimal(0),
        overdue: new Prisma.Decimal(0),
        buckets: {
          current: new Prisma.Decimal(0),
          days30: new Prisma.Decimal(0),
          days60: new Prisma.Decimal(0),
          days90: new Prisma.Decimal(0),
          over90: new Prisma.Decimal(0),
        },
        invoices: [],
      };

      row.total = row.total.add(outstanding);
      if (daysOverdue > 0) row.overdue = row.overdue.add(outstanding);
      row.buckets[bucket] = row.buckets[bucket].add(outstanding);
      row.invoices.push({
        id: invoice.id,
        number: invoice.number,
        dueDate: invoice.dueDate.toISOString().slice(0, 10),
        status: invoice.status,
        total: invoice.total.toFixed(2),
        paid: paid.toFixed(2),
        outstanding: outstanding.toFixed(2),
        daysOverdue: Math.max(0, daysOverdue),
      });
      accounts.set(invoice.accountId, row);
    }

    const items = [...accounts.values()]
      .map((row) => ({
        account: row.account,
        total: row.total.toFixed(2),
        overdue: row.overdue.toFixed(2),
        buckets: Object.fromEntries(
          buckets.map((bucket) => [bucket, row.buckets[bucket].toFixed(2)]),
        ) as Record<Bucket, string>,
        invoices: row.invoices,
      }))
      // Largest overdue first. The older a receivable, the harder it is to collect.
      .sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.total) - Number(a.total));

    const totals = buckets.reduce<Record<string, Prisma.Decimal>>((acc, bucket) => {
      acc[bucket] = items.reduce(
        (sum, row) => sum.add(new Prisma.Decimal(row.buckets[bucket])),
        new Prisma.Decimal(0),
      );
      return acc;
    }, {});

    return {
      asOf,
      items,
      totals: {
        ...Object.fromEntries(
          Object.entries(totals).map(([key, value]) => [key, value.toFixed(2)]),
        ),
        total: items
          .reduce((sum, row) => sum.add(new Prisma.Decimal(row.total)), new Prisma.Decimal(0))
          .toFixed(2),
        overdue: items
          .reduce((sum, row) => sum.add(new Prisma.Decimal(row.overdue)), new Prisma.Decimal(0))
          .toFixed(2),
      },
    };
  }

  /** Invoices not yet fully paid and what is left, earliest due date first. */
  private async openInvoices(accountId: string) {
    const invoices = await this.prisma.arInvoice.findMany({
      where: { accountId, status: { notIn: [ArInvoiceStatus.PAID, ArInvoiceStatus.VOID] } },
      include: { allocations: { select: { amount: true } } },
      orderBy: [{ dueDate: 'asc' }, { issuedAt: 'asc' }],
    });

    return invoices
      .map((invoice) => ({
        invoice,
        outstanding: invoice.total.sub(
          invoice.allocations.reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0)),
        ),
      }))
      .filter((row) => row.outstanding.greaterThan(0));
  }

  /** Fills the earliest-due invoices first, as older receivables are cleared first. */
  private autoAllocate(
    open: Array<{ invoice: { id: string }; outstanding: Prisma.Decimal }>,
    amount: Prisma.Decimal,
  ): Array<{ invoiceId: string; amount: Prisma.Decimal }> {
    const plan: Array<{ invoiceId: string; amount: Prisma.Decimal }> = [];
    let left = amount;

    for (const row of open) {
      if (left.lessThanOrEqualTo(0)) break;
      const apply = left.greaterThan(row.outstanding) ? row.outstanding : left;
      plan.push({ invoiceId: row.invoice.id, amount: apply });
      left = left.sub(apply);
    }

    return plan;
  }

  // --- Invoices -------------------------------------------------------------

  /**
   * Builds an invoice from the unbilled transactions.
   *
   * A transaction on an invoice never joins another — billing twice makes the
   * account pay twice.
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
   * Invoice status change.
   *
   * Voiding releases the transactions it held — otherwise a wrongly issued
   * invoice would keep them from ever being billed.
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

  /**
   * A single invoice.
   *
   * The material for the document sent to the account. Hotel details, the billed
   * lines, received and outstanding must all be here so nothing is reassembled.
   */
  async invoiceDetail(id: string, user: AuthUser) {
    const invoice = await this.prisma.arInvoice.findUnique({
      where: { id },
      include: {
        account: true,
        // Issuer printed on the invoice. The address is needed on the document.
        property: { select: { id: true, name: true, address: true, currency: true } },
        transactions: {
          include: { reservation: { select: { id: true, confirmationNumber: true } } },
          orderBy: { postedAt: 'asc' },
        },
        allocations: {
          include: {
            payment: { select: { id: true, description: true, postedAt: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!invoice) {
      throw new NotFoundException(`청구서를 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, invoice.propertyId);

    const paid = invoice.allocations.reduce(
      (sum, row) => sum.add(row.amount),
      new Prisma.Decimal(0),
    );
    const outstanding = invoice.total.sub(paid);
    const today = new Date().toISOString().slice(0, 10);
    const dueDate = invoice.dueDate.toISOString().slice(0, 10);

    return {
      ...invoice,
      paid: paid.toFixed(2),
      outstanding: outstanding.toFixed(2),
      // Void and paid invoices are not overdue.
      overdue:
        invoice.status !== ArInvoiceStatus.PAID &&
        invoice.status !== ArInvoiceStatus.VOID &&
        outstanding.greaterThan(0) &&
        dueDate < today,
    };
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

  /** The balance is never stored. It is re-summed every time — same rule as folios. */
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
   * Amount not yet on an invoice. This is what the next invoice will cover.
   *
   * Payments are excluded — a payment repays a charge rather than being one.
   * Counted in, next month's invoice would shrink by last month's payment.
   */
  private async unbilledTotal(accountId: string): Promise<string> {
    const total = await this.prisma.arTransaction.aggregate({
      where: { accountId, invoiceId: null, type: { not: ArTransactionType.PAYMENT } },
      _sum: { amount: true },
    });
    return (total._sum.amount ?? new Prisma.Decimal(0)).toFixed(2);
  }

  /**
   * Next invoice number.
   *
   * Numbered year-sequence per hotel. It is the identifier exchanged with the
   * account, so it must be human-readable; collisions across hotels are fine.
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
