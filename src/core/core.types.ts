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
  /** 단체 블록에서 빠져나온 예약이면 그 블록 코드 */
  blockCode?: string;
  /** 예약이 들어온 경로. 세 축을 따로 두어야 조합을 구분할 수 있다. */
  sourceCode?: string;
  marketCode?: string;
  channelCode?: string;
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
  sourceCode?: string;
  channelCode?: string;
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

/** OPERA 표기의 거래 종류. 부호는 종류가 정한다. */
export type CorePostingType = 'Charge' | 'Payment' | 'Adjustment' | 'Tax';

export interface CorePosting {
  postingId: string;
  type: CorePostingType;
  transactionCode: string;
  description: string;
  /** 부호가 붙은 값. 청구는 양수, 결제는 음수다. */
  amount: number;
  currencyCode: string;
  postedAt: string;
  reference?: string;
  voidedById?: string;
  transferredFromWindow?: number;
}

/** OPERA 가 확정한 폴리오. 잔액은 저쪽이 계산한 값이다. */
export interface CoreFolio {
  folioId: string;
  reservationId: string;
  window: number;
  status: 'Open' | 'Closed';
  balance: number;
  currencyCode: string;
  postings: CorePosting[];
}

export interface CoreFolioListResponse {
  reservationId: string;
  folios: CoreFolio[];
}

export interface CoreCreatePostingInput {
  hotelId?: string;
  type: CorePostingType;
  transactionCode: string;
  description: string;
  /** 항상 양수로 보낸다. 잔액 방향은 type 이 정한다. */
  amount: number;
  negative?: boolean;
  reference?: string;
}

/** 사용 불가 객실 기간. OutOfOrder 는 재고에서 빠지고 OutOfService 는 판매만 멈춘다. */
export interface CoreRoomOutage {
  outageId: string;
  hotelId: string;
  roomNumber: string;
  roomType?: string;
  kind: 'OutOfOrder' | 'OutOfService';
  startDate: string;
  endDate: string;
  reason: string;
  returnStatus: string;
}

export interface CoreRoomOutageListResponse {
  hotelId: string;
  items: CoreRoomOutage[];
}

export interface CoreCreateRoomOutageInput {
  hotelId?: string;
  roomNumber: string;
  kind: 'OutOfOrder' | 'OutOfService';
  startDate: string;
  endDate: string;
  reason: string;
  returnStatus?: string;
}

export interface CoreCreateReservationInput {
  hotelId?: string;
  arrivalDate: string;
  departureDate: string;
  roomTypeCode: string;
  ratePlanCode?: string;
  adults: number;
  children?: number;
  /** 단체 블록에서 빼는 예약이면 블록 코드. OPERA 가 픽업으로 잡는다. */
  blockCode?: string;
  /** 예약 경로. 비우면 OPERA 가 직접 예약으로 잡는다. */
  sourceCode?: string;
  marketCode?: string;
  channelCode?: string;
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

/**
 * 호텔의 영업일.
 *
 * 달력 날짜와 다르다. 야간 감사를 돌리기 전까지는 자정을 넘겨도 어제가 영업일로
 * 남고, 매출·점유율이 어느 날짜에 붙는지가 그 값으로 정해진다.
 */
export interface CoreBusinessDate {
  hotelId: string;
  businessDate: string;
  calendarDate: string;
}

export interface CoreProfile {
  profileId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  mergedIntoId?: string;
}

// --- 단체 블록 --------------------------------------------------------------

export type CoreBlockStatus = 'Inquiry' | 'Tentative' | 'Definite' | 'Cancelled' | 'Actual';

export interface CoreBlockAllotment {
  date: string;
  roomTypeCode: string;
  blocked: number;
  pickedUp: number;
  ratePlanCode?: string;
  amount?: number;
}

export interface CoreBlock {
  blockId: string;
  code: string;
  name: string;
  hotelId: string;
  status: CoreBlockStatus;
  startDate: string;
  endDate: string;
  cutoffDate?: string;
  currency?: string;
  allotments: CoreBlockAllotment[];
  totalBlocked: number;
  totalPickedUp: number;
}

export interface CoreBlockListResponse {
  items: CoreBlock[];
  limit: number;
  offset: number;
  total?: number;
}

export interface CoreBlockListParams {
  hotelId?: string;
  status?: CoreBlockStatus;
  startFrom?: string;
  limit?: number;
  offset?: number;
}

export interface CoreCreateBlockInput {
  hotelId?: string;
  code: string;
  name: string;
  startDate: string;
  endDate: string;
  cutoffDate?: string;
  status?: CoreBlockStatus;
  allotments: Array<{ roomTypeCode: string; blocked: number; ratePlanCode?: string }>;
}

export interface CoreUpdateBlockInput {
  name?: string;
  status?: CoreBlockStatus;
  cutoffDate?: string;
}

export interface CoreAvailabilityParams {
  hotelId?: string;
  arrivalDate: string;
  departureDate: string;
  adults?: number;
  children?: number;
  roomTypeCode?: string;
}
