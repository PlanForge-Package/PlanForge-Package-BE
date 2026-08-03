import { ReservationStatus } from '@prisma/client';
import {
  formatDateOnly,
  parseDateOnly,
  toCoreStatus,
  toReservationStatus,
} from './reservation.mapper';

describe('reservation.mapper', () => {
  describe('toReservationStatus', () => {
    it('OPERA 상태를 PlanForge 상태로 옮긴다', () => {
      expect(toReservationStatus('InHouse')).toBe(ReservationStatus.IN_HOUSE);
      expect(toReservationStatus('CheckedOut')).toBe(ReservationStatus.CHECKED_OUT);
      expect(toReservationStatus('NoShow')).toBe(ReservationStatus.NO_SHOW);
    });

    it('모르는 상태는 RESERVED 로 떨어뜨린다', () => {
      expect(toReservationStatus('SomethingNew')).toBe(ReservationStatus.RESERVED);
    });
  });

  describe('toCoreStatus', () => {
    it('왕복 변환이 원래 값을 지킨다', () => {
      for (const status of Object.values(ReservationStatus)) {
        const core = toCoreStatus(status);
        expect(core).toBeDefined();
        expect(toReservationStatus(core!)).toBe(status);
      }
    });
  });

  describe('parseDateOnly', () => {
    it('로컬 타임존과 무관하게 UTC 자정으로 파싱한다', () => {
      const parsed = parseDateOnly('2026-08-03');
      expect(parsed.toISOString()).toBe('2026-08-03T00:00:00.000Z');
    });

    it('시간이 붙어 있어도 날짜만 취한다', () => {
      expect(parseDateOnly('2026-08-03T15:30:00Z').toISOString()).toBe('2026-08-03T00:00:00.000Z');
    });

    it('형식이 어긋나면 던진다', () => {
      expect(() => parseDateOnly('2026/08/03')).toThrow(/날짜 형식/);
    });
  });

  describe('formatDateOnly', () => {
    it('parseDateOnly 와 왕복한다', () => {
      expect(formatDateOnly(parseDateOnly('2026-12-31'))).toBe('2026-12-31');
    });
  });
});
