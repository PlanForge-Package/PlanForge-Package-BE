import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { PosOutlet } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

/** 키를 실어 보내는 헤더. Authorization 을 쓰지 않는 이유는 JWT 와 섞이지 않게 하려고. */
export const POS_KEY_HEADER = 'x-pos-key';

/** 키 앞머리. 이걸로 후보를 좁히고 나머지는 bcrypt 로 확인한다. */
export const POS_KEY_PREFIX = 'pos_';

/** 화면과 로그에서 어느 키인지 알아볼 수 있게 남기는 앞자리 길이. */
export const POS_KEY_PREFIX_LENGTH = 12;

export interface PosRequest extends Request {
  outlet: PosOutlet;
}

/**
 * POS 아웃렛 인증.
 *
 * 직원 JWT 를 쓰지 않는다. 단말에 직원 비밀번호를 심게 되고, 그 단말이 직원
 * 권한 전부를 얻기 때문이다. 아웃렛마다 자기 키를 주고 이 가드가 붙은 라우트
 * 에서만 통하게 한다.
 *
 * 키는 bcrypt 해시로만 저장한다. 데이터베이스가 새어도 키 자체는 나가지 않는다.
 */
@Injectable()
export class PosKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PosRequest>();
    const raw = request.header(POS_KEY_HEADER);

    if (!raw || !raw.startsWith(POS_KEY_PREFIX)) {
      throw new UnauthorizedException('POS 키가 없거나 형식이 올바르지 않습니다.');
    }

    /*
     * 앞자리로 후보를 좁힌다.
     *
     * 전부 bcrypt 로 비교하면 아웃렛 수만큼 해시 연산이 돌아 룸차지 한 건이
     * 수백 밀리초씩 걸린다. 앞자리는 비밀이 아니므로 인덱스로 써도 안전하다.
     */
    const prefix = raw.slice(0, POS_KEY_PREFIX_LENGTH);
    const candidates = await this.prisma.posOutlet.findMany({
      where: { apiKeyPrefix: prefix, active: true },
    });

    for (const outlet of candidates) {
      if (await bcrypt.compare(raw, outlet.apiKeyHash)) {
        request.outlet = outlet;
        // 마지막 사용 시각은 죽은 단말을 찾는 유일한 단서다. 실패해도 요청은 살린다.
        void this.prisma.posOutlet
          .update({ where: { id: outlet.id }, data: { lastUsedAt: new Date() } })
          .catch(() => undefined);
        return true;
      }
    }

    // 비활성 아웃렛인지 없는 키인지 구분해 알려 주지 않는다 — 키 탐색의 단서가 된다.
    throw new UnauthorizedException('POS 키가 올바르지 않습니다.');
  }
}
