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
  CoreCreateRoomOutageInput,
  CoreProfile,
  CoreRateParams,
  CoreRateResponse,
  CoreReservation,
  CoreReservationListParams,
  CoreReservationListResponse,
  CoreRoomOutage,
  CoreRoomOutageListResponse,
  CoreRoomStatus,
  CoreUpdateBlockInput,
  CoreUpdateReservationInput,
} from './core.types';

type Query = Record<string, string | number | boolean | undefined>;

/**
 * Core(API Server) HTTP 클라이언트.
 *
 * Core 는 이미 OPERA 인증·토큰 캐시·응답 정규화를 처리하므로 BE 는 얇게 호출만 한다.
 * 재시도는 하지 않는다 — Core 가 401 재시도를 담당하고, 그 밖의 실패는 상위에서
 * SyncLog 에 남긴 뒤 배치로 다시 시도하는 편이 예약 같은 도메인에 안전하다.
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

  getBusinessDate(hotelId?: string): Promise<CoreBusinessDate> {
    return this.request<CoreBusinessDate>('/v1/business-date', { hotelId });
  }

  listBlocks(params: CoreBlockListParams = {}): Promise<CoreBlockListResponse> {
    return this.request<CoreBlockListResponse>('/v1/blocks', { ...params });
  }

  getBlock(blockId: string): Promise<CoreBlock> {
    return this.request<CoreBlock>(`/v1/blocks/${encodeURIComponent(blockId)}`);
  }

  /** 룸리스트 — 이 블록에서 빠져나간 예약. 블록 코드로 거르는 것은 Core 가 한다. */
  listBlockReservations(blockId: string): Promise<CoreReservationListResponse> {
    return this.request<CoreReservationListResponse>(
      `/v1/blocks/${encodeURIComponent(blockId)}/reservations`,
    );
  }

  // --- 쓰기. OPERA 가 재고·요금·확인 번호를 판단한다 --------------------------

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
   * 프로필 병합.
   *
   * 로컬에서만 합치면 OPERA 에는 여전히 둘이고, 다음 동기화가 지운 쪽을 되살린다.
   */
  mergeProfile(profileId: string, targetProfileId: string): Promise<CoreProfile> {
    return this.request<CoreProfile>(
      `/v1/profiles/${encodeURIComponent(profileId)}/merge`,
      undefined,
      { method: 'POST', json: { targetProfileId } },
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
