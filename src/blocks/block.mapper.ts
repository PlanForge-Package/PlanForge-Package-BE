import { BlockStatus } from '@prisma/client';
import type { CoreBlockStatus } from '../core/core.types';

/** Core (OPERA terms) to PlanForge block status. */
const STATUS_MAP: Record<CoreBlockStatus, BlockStatus> = {
  Inquiry: BlockStatus.INQUIRY,
  Tentative: BlockStatus.TENTATIVE,
  Definite: BlockStatus.DEFINITE,
  Cancelled: BlockStatus.CANCELLED,
  Actual: BlockStatus.ACTUAL,
};

/**
 * Unknown values fall back to TENTATIVE.
 *
 * Wrongly raising them to DEFINITE makes an unconfirmed group look like it holds
 * inventory and blocks normal sales. Erring towards less confirmed costs less.
 */
export function toBlockStatus(status: string): BlockStatus {
  return STATUS_MAP[status as CoreBlockStatus] ?? BlockStatus.TENTATIVE;
}

export function toCoreBlockStatus(status: BlockStatus): CoreBlockStatus | undefined {
  const entry = Object.entries(STATUS_MAP).find(([, value]) => value === status);
  return entry?.[0] as CoreBlockStatus | undefined;
}
