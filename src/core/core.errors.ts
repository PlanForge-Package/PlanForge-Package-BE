import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 호출자가 고칠 수 있는 거절은 그대로 통과시킨다.
 *
 * Core 는 OPERA 가 거절한 사유(날짜 오류·중복 코드·재실 객실 등)를 이 상태
 * 코드로 내려준다. 여기서 전부 502 로 바꾸면 화면에는 "게이트웨이 오류" 만
 * 남고 무엇을 고쳐야 하는지 사라진다.
 *
 * 401·403 은 뺐다 — Core 자격 증명 문제이지 사용자 잘못이 아니다.
 */
const CALLER_FIXABLE = new Set<number>([
  HttpStatus.BAD_REQUEST,
  HttpStatus.NOT_FOUND,
  HttpStatus.CONFLICT,
  HttpStatus.UNPROCESSABLE_ENTITY,
]);

const STATUS_NAMES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
};

/**
 * Core 호출 실패.
 *
 * 외부 시스템 장애(5xx·타임아웃)는 502 로 올려 FE 가 "재시도해 볼 문제" 로
 * 구분할 수 있게 하고, 입력 문제는 원래 상태와 사유를 그대로 전달한다.
 */
export class CoreApiError extends HttpException {
  constructor(
    readonly upstreamStatus: number,
    fallbackMessage: string,
    readonly body?: unknown,
  ) {
    const status = CALLER_FIXABLE.has(upstreamStatus) ? upstreamStatus : HttpStatus.BAD_GATEWAY;
    // Core 가 사유를 실어 보냈으면 그것을 쓴다. 사용자에게 훨씬 쓸모 있다.
    const message = (status === upstreamStatus && extractMessage(body)) || fallbackMessage;

    super({ statusCode: status, error: STATUS_NAMES[status] ?? 'Bad Gateway', message }, status);
    this.name = 'CoreApiError';
  }
}

function extractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

/** Core 에 아예 닿지 못했을 때 (네트워크 오류·타임아웃). */
export class CoreUnreachableError extends HttpException {
  constructor(message: string, cause?: unknown) {
    super(
      { statusCode: HttpStatus.BAD_GATEWAY, error: 'Bad Gateway', message },
      HttpStatus.BAD_GATEWAY,
      { cause: cause instanceof Error ? cause : undefined },
    );
    this.name = 'CoreUnreachableError';
  }
}
