import { RoomStatus } from '@prisma/client';

/** OPERA terms to PlanForge terms. The mapping is kept in one place. */
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
  // An unknown value falls back to DIRTY. Leaving it as needing cleaning is safer
  // than wrongly putting it back on sale.
  return (entry?.[0] as RoomStatus | undefined) ?? RoomStatus.DIRTY;
}
