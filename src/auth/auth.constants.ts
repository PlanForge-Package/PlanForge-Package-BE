import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

/** Marks routes reachable without authentication. */
export const IS_PUBLIC = 'planforge:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Roles allowed access. Without it, every authenticated role passes. */
export const REQUIRED_ROLES = 'planforge:roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(REQUIRED_ROLES, roles);

/** JWT payload. Carries name and email too, avoiding a DB read per request. */
export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  propertyId: string | null;
}

/** The authenticated principal the guard puts on the request. */
export interface AuthUser extends JwtPayload {
  id: string;
}
