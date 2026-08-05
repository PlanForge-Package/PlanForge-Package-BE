import type { AuthUser } from '../auth/auth.constants';
import { forbidden } from '../common/errors';

/**
 * Decides which hotels a request may see.
 *
 * In a multi-hotel setup this is the most important boundary. If staff assigned to
 * one hotel can read another's reservations and guests just by changing propertyId
 * in the query string, no amount of role checking helps.
 *
 * - Accounts with no property (head office, ADMIN): may name any hotel; omitted, they see all.
 * - Accounts with a property: fixed to their own hotel. Naming another is rejected.
 *
 * @returns propertyId to query with. `undefined` means every hotel.
 */
export function resolvePropertyScope(user: AuthUser, requested?: string): string | undefined {
  const assigned = user.propertyId;

  if (!assigned) {
    return requested || undefined;
  }

  if (requested && requested !== assigned) {
    throw forbidden('OTHER_PROPERTY_FORBIDDEN');
  }

  return assigned;
}

/**
 * Checks that already-fetched data lies within the requester's scope.
 *
 * Lists are filtered by scope, but one record is reachable from its id alone. A
 * leaked confirmation number or URL must not open another hotel's reservation.
 */
export function assertWithinScope(user: AuthUser, propertyId: string): void {
  if (user.propertyId && user.propertyId !== propertyId) {
    throw forbidden('OTHER_PROPERTY_FORBIDDEN');
  }
}
