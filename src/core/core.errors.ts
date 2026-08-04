import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Rejections the caller can fix are passed through unchanged.
 *
 * Core reports OPERA's reasons for refusing (bad dates, duplicate code, occupied
 * room) with these status codes. Turning them all into 502 leaves the screen with
 * "gateway error" and no idea what to fix.
 *
 * 401 and 403 are excluded — those are Core credential problems, not user error.
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
 * Core call failure.
 *
 * External failures (5xx, timeout) are raised as 502 so FE can tell "worth retrying"
 * apart, while input problems keep their original status and reason.
 */
export class CoreApiError extends HttpException {
  constructor(
    readonly upstreamStatus: number,
    fallbackMessage: string,
    readonly body?: unknown,
  ) {
    const status = CALLER_FIXABLE.has(upstreamStatus) ? upstreamStatus : HttpStatus.BAD_GATEWAY;
    // Core's own reason is used when it sent one. It is far more useful to the user.
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

/** When Core could not be reached at all (network error, timeout). */
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
