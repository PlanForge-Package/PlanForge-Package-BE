/**
 * Response shapes returned by Core (the API server).
 *
 * Core normalises OPERA into PlanForge's own shape rather than passing the
 * original through, so BE never needs OHIP field names. The schema of record is
 * Core's `openapi/planforge-core.json`, and these definitions must match it.
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

/** OPERA reservation statuses as Core spells them. */
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
  /** Block code, if the reservation was picked up from a group block */
  blockCode?: string;
  /** Group of reservations sharing a room. Two reservations, one room. */
  shareGroupId?: string;
  /** Where the booking came from. Three separate axes keep combinations distinct. */
  sourceCode?: string;
  marketCode?: string;
  channelCode?: string;
  /** Guarantee type — SIXPM · CREDITCARD · DEPOSIT · COMPANY · COMP. */
  guaranteeCode?: string;
  /** Penalty charged on cancellation. Present only on cancelled reservations. */
  cancellationPenalty?: number;
  guest?: {
    profileId?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

export interface CoreShareResponse {
  shareGroupId: string;
  reservations: CoreReservation[];
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
  /** Package amount for that day. Packages included in the rate are 0. */
  packageAmount?: number;
}

export interface CoreRateOfferPackage {
  packageCode: string;
  name: string;
  amount: number;
  calculation: string;
  includedInRate: boolean;
}

export interface CoreRateOffer {
  ratePlanCode: string;
  ratePlanName?: string;
  roomTypeCode: string;
  roomTypeName?: string;
  currency: string;
  nightlyRates: CoreNightlyRate[];
  packages?: CoreRateOfferPackage[];
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
  adults?: number;
}

// --- Rate code configuration. OPERA owns it, so no local copy ----------------

export interface CoreRateSeason {
  seasonId: string;
  name: string;
  startDate: string;
  endDate: string;
  /** 0=Sunday. Empty means every day in the range. */
  daysOfWeek?: number[];
  amounts: Record<string, number>;
}

export interface CoreRatePlan {
  ratePlanCode: string;
  hotelId: string;
  name: string;
  description?: string;
  currency: string;
  marketCode: string;
  sellStartDate: string;
  sellEndDate: string;
  baseAmounts: Record<string, number>;
  seasons: CoreRateSeason[];
  packageCodes: string[];
  status: string;
}

export interface CoreRatePlanListResponse {
  hotelId: string;
  items: CoreRatePlan[];
}

export interface CoreCreateRatePlanInput {
  hotelId?: string;
  ratePlanCode: string;
  name: string;
  description?: string;
  currency?: string;
  marketCode?: string;
  sellStartDate: string;
  sellEndDate: string;
  baseAmounts: Record<string, number>;
  packageCodes?: string[];
  status?: 'Active' | 'Inactive';
}

export interface CoreUpdateRatePlanInput {
  hotelId?: string;
  name?: string;
  description?: string;
  marketCode?: string;
  sellStartDate?: string;
  sellEndDate?: string;
  baseAmounts?: Record<string, number>;
  packageCodes?: string[];
  status?: 'Active' | 'Inactive';
}

export interface CoreCreateSeasonInput {
  hotelId?: string;
  name: string;
  startDate: string;
  endDate: string;
  daysOfWeek?: number[];
  amounts: Record<string, number>;
}

export interface CorePackage {
  packageCode: string;
  hotelId: string;
  name: string;
  amount: number;
  calculation: string;
  transactionCode: string;
  includedInRate: boolean;
}

export interface CorePackageListResponse {
  hotelId: string;
  items: CorePackage[];
}

export interface CoreCreatePackageInput {
  hotelId?: string;
  packageCode: string;
  name: string;
  amount: number;
  calculation: 'PerNight' | 'PerStay' | 'PerPerson';
  transactionCode: string;
  includedInRate?: boolean;
}

export interface CoreTransactionCode {
  transactionCode: string;
  hotelId: string;
  name: string;
  /** Room, FoodBeverage, Other and Payment. */
  group: string;
  vatRate: number;
  serviceChargeRate: number;
  /** True when the displayed price already includes tax. */
  taxInclusive: boolean;
  active: boolean;
}

export interface CoreTransactionCodeListResponse {
  hotelId: string;
  items: CoreTransactionCode[];
}

/** Cancellation terms and deposit. The guest hears this before we cancel. */
export interface CoreReservationPolicies {
  reservationId: string;
  guaranteeCode: string;
  currency: string;
  cancellation: {
    policyName: string;
    freeUntil: string;
    withinFreeWindow: boolean;
    penaltyAmount: number;
  };
  deposit: {
    requiredAmount: number;
    dueDate?: string;
    paidAmount: number;
  };
}

export interface CoreDepositInput {
  hotelId?: string;
  amount: number;
  description?: string;
  transactionCode?: string;
  /** Check number that stops the same deposit being taken twice. */
  reference?: string;
}

export interface CoreCreateTransactionCodeInput {
  hotelId?: string;
  transactionCode: string;
  name: string;
  group: 'Room' | 'FoodBeverage' | 'Other' | 'Payment';
  vatRate?: number;
  serviceChargeRate?: number;
  taxInclusive?: boolean;
}

export interface CoreUpdateTransactionCodeInput {
  hotelId?: string;
  name?: string;
  group?: 'Room' | 'FoodBeverage' | 'Other' | 'Payment';
  vatRate?: number;
  serviceChargeRate?: number;
  taxInclusive?: boolean;
  active?: boolean;
}

export interface CoreUpdatePackageInput {
  hotelId?: string;
  name?: string;
  amount?: number;
  calculation?: 'PerNight' | 'PerStay' | 'PerPerson';
  transactionCode?: string;
  includedInRate?: boolean;
}

/** Room status as Core normalised it from OPERA. */
export interface CoreRoomStatus {
  hotelId: string;
  roomNumber: string;
  status: string;
  occupied?: boolean;
}

/** Transaction kind in OPERA's terms. The kind sets the sign. */
export type CorePostingType = 'Charge' | 'Payment' | 'Adjustment' | 'Tax';

export interface CorePosting {
  postingId: string;
  type: CorePostingType;
  transactionCode: string;
  description: string;
  /** Signed value. Charges are positive, payments negative. */
  amount: number;
  currencyCode: string;
  postedAt: string;
  reference?: string;
  voidedById?: string;
  transferredFromWindow?: number;
}

/** A folio as OPERA confirmed it. The balance is their figure. */
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
  /** Always sent positive. The type decides which way the balance moves. */
  amount: number;
  negative?: boolean;
  reference?: string;
}

/** Room outage. OutOfOrder leaves inventory; OutOfService only stops sales. */
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
  /** Block code when picking up from a group block. OPERA counts it as pickup. */
  blockCode?: string;
  /** Take a waitlist booking even when sold out. It holds no inventory. */
  waitlist?: boolean;
  /** Booking origin. Empty lets OPERA default it to a direct booking. */
  sourceCode?: string;
  marketCode?: string;
  channelCode?: string;
  /** Guarantee type. Empty means 6PM — an unguaranteed booking is held until 18:00. */
  guaranteeCode?: string;
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
 * The hotel's business date.
 *
 * Not the calendar date. Until night audit runs, yesterday stays the business date
 * past midnight, and that value decides which day revenue and occupancy land on.
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

// --- Group blocks -----------------------------------------------------------

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
  allotments: Array<{
    roomTypeCode: string;
    blocked: number;
    ratePlanCode?: string;
    /** Negotiated amount. Set, it is sold at this price instead of the rate code's. */
    amount?: number;
  }>;
}

export interface CoreUpdateBlockInput {
  name?: string;
  status?: CoreBlockStatus;
  cutoffDate?: string;
  rates?: Array<{ roomTypeCode: string; ratePlanCode?: string; amount: number }>;
}

export interface CoreAvailabilityParams {
  hotelId?: string;
  arrivalDate: string;
  departureDate: string;
  adults?: number;
  children?: number;
  roomTypeCode?: string;
}
