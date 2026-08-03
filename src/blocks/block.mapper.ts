import { BlockStatus } from '@prisma/client';
import type { CoreBlockStatus } from '../core/core.types';

/** Core(OPERA 표기) ↔ PlanForge 블록 상태. */
const STATUS_MAP: Record<CoreBlockStatus, BlockStatus> = {
  Inquiry: BlockStatus.INQUIRY,
  Tentative: BlockStatus.TENTATIVE,
  Definite: BlockStatus.DEFINITE,
  Cancelled: BlockStatus.CANCELLED,
  Actual: BlockStatus.ACTUAL,
};

/**
 * 모르는 값은 TENTATIVE 로 둔다.
 *
 * DEFINITE 로 잘못 올리면 아직 확정되지 않은 단체가 재고를 잡은 것처럼 보여
 * 일반 판매를 막는다. 덜 확정된 쪽으로 기우는 편이 손실이 작다.
 */
export function toBlockStatus(status: string): BlockStatus {
  return STATUS_MAP[status as CoreBlockStatus] ?? BlockStatus.TENTATIVE;
}

export function toCoreBlockStatus(status: BlockStatus): CoreBlockStatus | undefined {
  const entry = Object.entries(STATUS_MAP).find(([, value]) => value === status);
  return entry?.[0] as CoreBlockStatus | undefined;
}
