import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { ArService } from './ar.service';
import {
  AgingDto,
  CreateAccountDto,
  CreateInvoiceDto,
  ListAccountsDto,
  RecordArPaymentDto,
  TransferToArDto,
  UpdateAccountDto,
  UpdateInvoiceStatusDto,
} from './dto/ar.dto';

/**
 * AR / city ledger — direct-bill accounts.
 *
 * Registering accounts and issuing invoices is receivables management, so a manager
 * owns it. Folio transfers happen at departure, so the front desk needs them too.
 */
@ApiTags('ar')
@ApiBearerAuth()
@Controller('ar')
export class ArController {
  constructor(private readonly ar: ArService) {}

  @Get('accounts')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '거래처 목록 — 잔액 포함' })
  listAccounts(@Query() query: ListAccountsDto, @CurrentUser() user: AuthUser) {
    return this.ar.listAccounts(query, user);
  }

  // Aging comes before the account list — it keeps the route from matching :id.
  @Get('aging')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '연체 현황 — 거래처별 경과 구간과 청구서' })
  aging(@Query() query: AgingDto, @CurrentUser() user: AuthUser) {
    return this.ar.aging(query, user);
  }

  @Get('accounts/:id')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '거래처 상세 — 잔액·거래·청구서' })
  accountDetail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.ar.accountDetail(id, user);
  }

  @Post('accounts')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '거래처 등록' })
  createAccount(@Body() dto: CreateAccountDto, @CurrentUser() user: AuthUser) {
    return this.ar.createAccount(dto, user);
  }

  @Patch('accounts/:id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '거래처 수정 — 여신 한도·결제 조건·거래 중지' })
  updateAccount(
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ar.updateAccount(id, dto, user);
  }

  @Post('accounts/:id/payments')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '거래처 입금 기록' })
  recordPayment(
    @Param('id') id: string,
    @Body() dto: RecordArPaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ar.recordPayment(id, dto, user);
  }

  @Post('accounts/:id/invoices')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '청구서 발행 — 미청구 거래를 모읍니다' })
  createInvoice(
    @Param('id') id: string,
    @Body() dto: CreateInvoiceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ar.createInvoice(id, dto, user);
  }

  @Get('invoices/:id')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '청구서 상세' })
  invoiceDetail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.ar.invoiceDetail(id, user);
  }

  @Patch('invoices/:id/status')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '청구서 상태 — 무효로 돌리면 거래를 다시 풀어 줍니다' })
  updateInvoiceStatus(
    @Param('id') id: string,
    @Body() dto: UpdateInvoiceStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ar.updateInvoiceStatus(id, dto, user);
  }
}

/**
 * Folio to account transfer.
 *
 * It sits under the reservation because the front desk uses it while checking a guest out.
 */
@ApiTags('ar')
@ApiBearerAuth()
@Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
@Controller('reservations/:reservationId/ar')
export class ReservationArController {
  constructor(private readonly ar: ArService) {}

  @Post('transfer')
  @ApiOperation({ summary: '폴리오 잔액을 거래처로 이관 — OPERA 폴리오도 비웁니다' })
  transfer(
    @Param('reservationId') reservationId: string,
    @Body() dto: TransferToArDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ar.transferFolio(reservationId, dto, user);
  }
}
