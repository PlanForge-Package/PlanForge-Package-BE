import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CoreApiError, CoreUnreachableError } from './core.errors';
import type {
  CoreAvailabilityParams,
  CoreAvailabilityResponse,
  CoreBlock,
  CoreBlockListParams,
  CoreBlockListResponse,
  CoreBusinessDate,
  CoreCreateBlockInput,
  CoreCreateReservationInput,
  CoreCreatePostingInput,
  CoreDepositInput,
  CoreReservationPolicies,
  CoreCreateRoomOutageInput,
  CoreFolio,
  CoreFolioListResponse,
  CoreCreatePackageInput,
  CoreCreateRatePlanInput,
  CoreCreateSeasonInput,
  CoreCreateTransactionCodeInput,
  CoreTransactionCode,
  CoreTransactionCodeListResponse,
  CoreUpdateTransactionCodeInput,
  CorePackage,
  CorePackageListResponse,
  CoreProfile,
  CoreRateParams,
  CoreRatePlan,
  CoreRatePlanListResponse,
  CoreRateResponse,
  CoreUpdatePackageInput,
  CoreUpdateRatePlanInput,
  CoreReservation,
  CoreReservationListParams,
  CoreReservationListResponse,
  CoreRoomOutage,
  CoreShareResponse,
  CoreRoomOutageListResponse,
  CoreRoomStatus,
  CoreUpdateBlockInput,
  CoreUpdateReservationInput,
} from './core.types';

type Query = Record<string, string | number | boolean | undefined>;

/**
 * HTTP client for Core (the API server).
 *
 * Core already handles OPERA auth, token caching and response normalisation, so BE
 * calls it thinly. No retries here — Core owns the 401 retry, and for a domain like
 * reservations it is safer to log other failures to SyncLog and retry by batch.
 */
@Injectable()
export class CoreClient {
  private readonly logger = new Logger(CoreClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('CORE_BASE_URL') ?? 'http://localhost:3002').replace(
      /\/$/,
      '',
    );
    this.apiKey = config.get<string>('CORE_API_KEY') ?? '';
    this.timeoutMs = Number(config.get<string>('CORE_REQUEST_TIMEOUT_MS') ?? '15000');
  }

  getAvailability(params: CoreAvailabilityParams): Promise<CoreAvailabilityResponse> {
    return this.request<CoreAvailabilityResponse>('/v1/availability', { ...params });
  }

  listReservations(params: CoreReservationListParams = {}): Promise<CoreReservationListResponse> {
    return this.request<CoreReservationListResponse>('/v1/reservations', { ...params });
  }

  getReservation(reservationId: string): Promise<CoreReservation> {
    return this.request<CoreReservation>(`/v1/reservations/${encodeURIComponent(reservationId)}`);
  }

  getRates(params: CoreRateParams): Promise<CoreRateResponse> {
    return this.request<CoreRateResponse>('/v1/rates', { ...params });
  }

  // --- Rate code setup -------------------------------------------------------

  listRatePlans(hotelId?: string, status?: string): Promise<CoreRatePlanListResponse> {
    return this.request<CoreRatePlanListResponse>('/v1/rate-plans', { hotelId, status });
  }

  getRatePlan(ratePlanCode: string, hotelId?: string): Promise<CoreRatePlan> {
    return this.request<CoreRatePlan>(`/v1/rate-plans/${encodeURIComponent(ratePlanCode)}`, {
      hotelId,
    });
  }

  createRatePlan(input: CoreCreateRatePlanInput): Promise<CoreRatePlan> {
    return this.request<CoreRatePlan>('/v1/rate-plans', undefined, {
      method: 'POST',
      json: input,
    });
  }

  updateRatePlan(ratePlanCode: string, input: CoreUpdateRatePlanInput): Promise<CoreRatePlan> {
    return this.request<CoreRatePlan>(
      `/v1/rate-plans/${encodeURIComponent(ratePlanCode)}`,
      undefined,
      { method: 'PATCH', json: input },
    );
  }

  addRateSeason(ratePlanCode: string, input: CoreCreateSeasonInput): Promise<CoreRatePlan> {
    return this.request<CoreRatePlan>(
      `/v1/rate-plans/${encodeURIComponent(ratePlanCode)}/seasons`,
      undefined,
      { method: 'POST', json: input },
    );
  }

  removeRateSeason(
    ratePlanCode: string,
    seasonId: string,
    hotelId?: string,
  ): Promise<CoreRatePlan> {
    return this.request<CoreRatePlan>(
      `/v1/rate-plans/${encodeURIComponent(ratePlanCode)}/seasons/${encodeURIComponent(seasonId)}`,
      undefined,
      { method: 'DELETE', json: { hotelId } },
    );
  }

  // --- Transaction codes -----------------------------------------------------

  listTransactionCodes(
    hotelId?: string,
    includeInactive?: boolean,
  ): Promise<CoreTransactionCodeListResponse> {
    return this.request<CoreTransactionCodeListResponse>('/v1/transaction-codes', {
      hotelId,
      includeInactive,
    });
  }

  createTransactionCode(input: CoreCreateTransactionCodeInput): Promise<CoreTransactionCode> {
    return this.request<CoreTransactionCode>('/v1/transaction-codes', undefined, {
      method: 'POST',
      json: input,
    });
  }

  updateTransactionCode(
    transactionCode: string,
    input: CoreUpdateTransactionCodeInput,
  ): Promise<CoreTransactionCode> {
    return this.request<CoreTransactionCode>(
      `/v1/transaction-codes/${encodeURIComponent(transactionCode)}`,
      undefined,
      { method: 'PATCH', json: input },
    );
  }

  listPackages(hotelId?: string): Promise<CorePackageListResponse> {
    return this.request<CorePackageListResponse>('/v1/packages', { hotelId });
  }

  createPackage(input: CoreCreatePackageInput): Promise<CorePackage> {
    return this.request<CorePackage>('/v1/packages', undefined, { method: 'POST', json: input });
  }

  updatePackage(packageCode: string, input: CoreUpdatePackageInput): Promise<CorePackage> {
    return this.request<CorePackage>(`/v1/packages/${encodeURIComponent(packageCode)}`, undefined, {
      method: 'PATCH',
      json: input,
    });
  }

  getBusinessDate(hotelId?: string): Promise<CoreBusinessDate> {
    return this.request<CoreBusinessDate>('/v1/business-date', { hotelId });
  }

  listBlocks(params: CoreBlockListParams = {}): Promise<CoreBlockListResponse> {
    return this.request<CoreBlockListResponse>('/v1/blocks', { ...params });
  }

  getBlock(blockId: string): Promise<CoreBlock> {
    return this.request<CoreBlock>(`/v1/blocks/${encodeURIComponent(blockId)}`);
  }

  /** Rooming list — reservations picked up from this block. Core filters by block code. */
  listBlockReservations(blockId: string): Promise<CoreReservationListResponse> {
    return this.request<CoreReservationListResponse>(
      `/v1/blocks/${encodeURIComponent(blockId)}/reservations`,
    );
  }

  // --- Writes. OPERA decides inventory, rates and confirmation numbers ---------

  createBlock(input: CoreCreateBlockInput): Promise<CoreBlock> {
    return this.request<CoreBlock>('/v1/blocks', undefined, { method: 'POST', json: input });
  }

  updateBlock(blockId: string, input: CoreUpdateBlockInput): Promise<CoreBlock> {
    return this.request<CoreBlock>(`/v1/blocks/${encodeURIComponent(blockId)}`, undefined, {
      method: 'PATCH',
      json: input,
    });
  }

  createReservation(input: CoreCreateReservationInput): Promise<CoreReservation> {
    return this.request<CoreReservation>('/v1/reservations', undefined, {
      method: 'POST',
      json: input,
    });
  }

  updateReservation(
    reservationId: string,
    input: CoreUpdateReservationInput,
  ): Promise<CoreReservation> {
    return this.request<CoreReservation>(
      `/v1/reservations/${encodeURIComponent(reservationId)}`,
      undefined,
      { method: 'PATCH', json: input },
    );
  }

  updateRoomStatus(
    roomNumber: string,
    input: { hotelId?: string; status: string; reason?: string },
  ): Promise<CoreRoomStatus> {
    return this.request<CoreRoomStatus>(
      `/v1/housekeeping/rooms/${encodeURIComponent(roomNumber)}/status`,
      undefined,
      { method: 'PUT', json: input },
    );
  }

  // --- Folios. OPERA owns the ledger and computes the balance ----------------

  listFolios(reservationId: string): Promise<CoreFolioListResponse> {
    return this.request<CoreFolioListResponse>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/folios`,
    );
  }

  openFolio(
    reservationId: string,
    input: { hotelId?: string; window?: number },
  ): Promise<CoreFolio> {
    return this.request<CoreFolio>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/folios`,
      undefined,
      { method: 'POST', json: input },
    );
  }

  createPosting(
    reservationId: string,
    window: number,
    input: CoreCreatePostingInput,
  ): Promise<CoreFolio> {
    return this.request<CoreFolio>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/folios/${window}/postings`,
      undefined,
      { method: 'POST', json: input },
    );
  }

  voidPosting(
    reservationId: string,
    postingId: string,
    input: { hotelId?: string; reason?: string; reference?: string },
  ): Promise<CoreFolio> {
    return this.request<CoreFolio>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/folios/postings/${encodeURIComponent(postingId)}/void`,
      undefined,
      { method: 'POST', json: input },
    );
  }

  transferPosting(
    reservationId: string,
    postingId: string,
    input: { hotelId?: string; toWindow: number },
  ): Promise<CoreFolioListResponse> {
    return this.request<CoreFolioListResponse>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/folios/postings/${encodeURIComponent(postingId)}/transfer`,
      undefined,
      { method: 'POST', json: input },
    );
  }

  closeFolio(
    reservationId: string,
    window: number,
    input: { hotelId?: string },
  ): Promise<CoreFolio> {
    return this.request<CoreFolio>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/folios/${window}/close`,
      undefined,
      { method: 'POST', json: input },
    );
  }

  listRoomOutages(params: {
    hotelId?: string;
    roomNumber?: string;
    onDate?: string;
  }): Promise<CoreRoomOutageListResponse> {
    return this.request<CoreRoomOutageListResponse>('/v1/housekeeping/outages', { ...params });
  }

  createRoomOutage(input: CoreCreateRoomOutageInput): Promise<CoreRoomOutage> {
    return this.request<CoreRoomOutage>('/v1/housekeeping/outages', undefined, {
      method: 'POST',
      json: input,
    });
  }

  releaseRoomOutage(
    outageId: string,
    input: { hotelId?: string; reason?: string },
  ): Promise<CoreRoomOutage> {
    return this.request<CoreRoomOutage>(
      `/v1/housekeeping/outages/${encodeURIComponent(outageId)}`,
      undefined,
      { method: 'DELETE', json: input },
    );
  }

  /**
   * Profile merge.
   *
   * Merged locally only, OPERA still has two and the next sync revives the removed one.
   */
  mergeProfile(profileId: string, targetProfileId: string): Promise<CoreProfile> {
    return this.request<CoreProfile>(
      `/v1/profiles/${encodeURIComponent(profileId)}/merge`,
      undefined,
      { method: 'POST', json: { targetProfileId } },
    );
  }

  /**
   * Check-in.
   *
   * The room number goes with it. Without knowing which room the guest entered,
   * OPERA still sees it free and assigns it to another reservation.
   */
  checkInReservation(
    reservationId: string,
    input: { hotelId?: string; roomNumber: string },
  ): Promise<CoreReservation> {
    return this.request<CoreReservation>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/check-in`,
      undefined,
      { method: 'POST', json: input },
    );
  }

  checkOutReservation(
    reservationId: string,
    input: { hotelId?: string } = {},
  ): Promise<CoreReservation> {
    return this.request<CoreReservation>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/check-out`,
      undefined,
      { method: 'POST', json: input },
    );
  }

  /**
   * Waitlist confirmation.
   *
   * OPERA counts availability at the moment of confirming. Deciding ahead of it
   * misses the case where another waitlisted booking was confirmed in between.
   */
  confirmWaitlist(reservationId: string, hotelId?: string): Promise<CoreReservation> {
    return this.request<CoreReservation>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/confirm-waitlist`,
      undefined,
      { method: 'POST', json: hotelId ? { hotelId } : {} },
    );
  }

  /** Room share. Two reservations use one room and settle separately. */
  shareReservation(
    reservationId: string,
    input: { hotelId?: string; withReservationId: string },
  ): Promise<CoreShareResponse> {
    return this.request<CoreShareResponse>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/share`,
      undefined,
      { method: 'POST', json: input },
    );
  }

  unshareReservation(reservationId: string, hotelId?: string): Promise<CoreReservation> {
    return this.request<CoreReservation>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/unshare`,
      undefined,
      { method: 'POST', json: hotelId ? { hotelId } : {} },
    );
  }

  noShowReservation(reservationId: string, reason?: string): Promise<CoreReservation> {
    return this.request<CoreReservation>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/no-show`,
      undefined,
      { method: 'POST', json: reason ? { reason } : {} },
    );
  }

  cancelReservation(reservationId: string, reason?: string): Promise<CoreReservation> {
    return this.request<CoreReservation>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/cancel`,
      undefined,
      { method: 'POST', json: reason ? { reason } : {} },
    );
  }

  // --- Cancellation terms, deposit and guarantee ------------------------------

  getReservationPolicies(
    reservationId: string,
    hotelId?: string,
  ): Promise<CoreReservationPolicies> {
    return this.request<CoreReservationPolicies>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/policies`,
      { hotelId },
    );
  }

  setGuarantee(
    reservationId: string,
    guaranteeCode: string,
    hotelId?: string,
  ): Promise<CoreReservation> {
    return this.request<CoreReservation>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/guarantee`,
      undefined,
      { method: 'PUT', json: { hotelId, guaranteeCode } },
    );
  }

  recordDeposit(reservationId: string, input: CoreDepositInput): Promise<CoreFolio> {
    return this.request<CoreFolio>(
      `/v1/reservations/${encodeURIComponent(reservationId)}/deposit`,
      undefined,
      { method: 'POST', json: input },
    );
  }

  private async request<T>(
    path: string,
    query?: Query,
    options: { method?: string; json?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
        },
        ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      this.logger.error(
        `Core 호출 실패: ${path}`,
        cause instanceof Error ? cause.stack : undefined,
      );
      throw new CoreUnreachableError('Core API 서버에 연결하지 못했습니다.', cause);
    }

    const text = await res.text();
    const body: unknown = text ? safeJson(text) : null;

    if (!res.ok) {
      this.logger.warn(`Core 응답 오류 ${res.status}: ${path}`);
      throw new CoreApiError(
        res.status,
        `Core 호출이 ${res.status} 로 실패했습니다: ${path}`,
        body,
      );
    }

    return body as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
