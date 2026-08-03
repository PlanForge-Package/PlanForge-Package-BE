import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

/** 인증 없이 접근할 수 있는 라우트에 붙인다. */
export const IS_PUBLIC = 'planforge:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** 접근을 허용할 역할. 붙이지 않으면 인증된 모든 역할이 통과한다. */
export const REQUIRED_ROLES = 'planforge:roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(REQUIRED_ROLES, roles);

/** JWT 페이로드. 이름·이메일까지 담아 매 요청 DB 조회를 피한다. */
export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  propertyId: string | null;
}

/** 가드가 request 에 심어 두는 인증 주체. */
export interface AuthUser extends JwtPayload {
  id: string;
}
