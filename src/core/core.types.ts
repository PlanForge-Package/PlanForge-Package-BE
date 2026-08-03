/**
 * Core(API Server)가 반환하는 응답 형태.
 *
 * Core 는 OPERA 원본이 아니라 PlanForge 표준 형태로 정규화해 내려주므로,
 * BE 는 OHIP 필드명을 알 필요가 없다. 스키마 원본은 Core 의
 * `openapi/planforge-core.json` 이며, 여기 정의는 그와 일치해야 한다.
 */

export interface CoreAvailabilityItem {
  roomTypeCode: string;
  roomTypeName?: string;
  availableRooms: number;
  ratePlanCode?: string;
  amount?: number;
  currency?: string;
}

export interface CoreAvailabilityResponse {
  hotelId: string;
  arrivalDate: string;
  departureDate: string;
  items: CoreAvailabilityItem[];
}

/** Core 가 쓰는 OPERA 예약 상태 표기. */
export type CoreReservationStatus =
  'Reserved' | 'Confirmed' | 'InHouse' | 'CheckedOut' | 'Cancelled' | 'NoShow' | 'Waitlisted';

export interface CoreReservation {
  reservationId: string;
  confirmationNumber?: string;
  hotelId: string;
  status: CoreReservationStatus;
  arrivalDate: string;
  departureDate: string;
  roomTypeCode?: string;
  ratePlanCode?: string;
  roomNumber?: string;
  adults?: number;
  children?: number;
  totalAmount?: number;
  currency?: string;
  guest?: {
    profileId?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

export interface CoreReservationListResponse {
  items: CoreReservation[];
  limit: number;
  offset: number;
  total?: number;
}

export interface CoreReservationListParams {
  hotelId?: string;
  arrivalDate?: string;
  departureDate?: string;
  status?: CoreReservationStatus;
  limit?: number;
  offset?: number;
}

export interface CoreNightlyRate {
  date: string;
  amount: number;
}

export interface CoreRateOffer {
  ratePlanCode: string;
  roomTypeCode: string;
  roomTypeName?: string;
  currency: string;
  nightlyRates: CoreNightlyRate[];
  totalAmount: number;
}

export interface CoreRateResponse {
  hotelId: string;
  arrivalDate: string;
  departureDate: string;
  nights: number;
  offers: CoreRateOffer[];
}

export interface CoreRateParams {
  hotelId?: string;
  arrivalDate: string;
  departureDate: string;
  roomTypeCode?: string;
  ratePlanCode?: string;
}

/** Core 가 OPERA 에서 받아 정규화한 객실 상태. */
export interface CoreRoomStatus {
  hotelId: string;
  roomNumber: string;
  status: string;
  occupied?: boolean;
}

export interface CoreCreateReservationInput {
  hotelId?: string;
  arrivalDate: string;
  departureDate: string;
  roomTypeCode: string;
  ratePlanCode?: string;
  adults: number;
  children?: number;
  guest: {
    profileId?: string;
    firstName: string;
    lastName: string;
    email?: string;
  };
}

export interface CoreUpdateReservationInput {
  arrivalDate?: string;
  departureDate?: string;
  roomTypeCode?: string;
  ratePlanCode?: string;
  adults?: number;
  children?: number;
}

export interface CoreAvailabilityParams {
  hotelId?: string;
  arrivalDate: string;
  departureDate: string;
  adults?: number;
  children?: number;
  roomTypeCode?: string;
}
