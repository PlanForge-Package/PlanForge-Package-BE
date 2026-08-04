import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthorizePaymentDto, CapturePaymentDto, RefundPaymentDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // Taking payment is the front desk's daily work.
  @Get('reservations/:id/payments')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '이 예약의 결제 이력' })
  list(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.payments.listByReservation(id, user);
  }

  @Post('reservations/:id/folios/:window/payments')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '승인 — 카드는 승인만, 현금·이체는 곧바로 매입' })
  authorize(
    @Param('id') id: string,
    @Param('window', ParseIntPipe) window: number,
    @Body() dto: AuthorizePaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payments.authorize(id, window, dto, user);
  }

  @Post('payments/:paymentId/capture')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '매입 — 이때 폴리오에 결제가 올라갑니다' })
  capture(
    @Param('paymentId') paymentId: string,
    @Body() dto: CapturePaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payments.capture(paymentId, dto, user);
  }

  @Post('payments/:paymentId/void')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '승인 취소 — 매입 전에만 됩니다' })
  void(@Param('paymentId') paymentId: string, @CurrentUser() user: AuthUser) {
    return this.payments.void(paymentId, user);
  }

  // A refund sends money out. Managers and above only.
  @Post('payments/:paymentId/refund')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '환불 — 매입 후. 부분 환불이 됩니다' })
  refund(
    @Param('paymentId') paymentId: string,
    @Body() dto: RefundPaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payments.refund(paymentId, dto, user);
  }
}
