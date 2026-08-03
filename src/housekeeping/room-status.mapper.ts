import { RoomStatus } from '@prisma/client';

/** OPERA 표기 ↔ PlanForge 표기. 매핑을 한 곳에 모아 둔다. */
const TO_OPERA: Record<RoomStatus, string> = {
  [RoomStatus.CLEAN]: 'Clean',
  [RoomStatus.DIRTY]: 'Dirty',
  [RoomStatus.INSPECTED]: 'Inspected',
  [RoomStatus.OUT_OF_ORDER]: 'OutOfOrder',
  [RoomStatus.OUT_OF_SERVICE]: 'OutOfService',
};

export function toOperaRoomStatus(status: RoomStatus): string {
  return TO_OPERA[status];
}

export function fromOperaRoomStatus(status: string): RoomStatus {
  const entry = Object.entries(TO_OPERA).find(([, opera]) => opera === status);
  // 모르는 값이 오면 DIRTY 로 떨어뜨린다. 판매 가능으로 잘못 올리는 것보다
  // 청소 필요로 두는 편이 안전하다.
  return (entry?.[0] as RoomStatus | undefined) ?? RoomStatus.DIRTY;
}
