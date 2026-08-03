import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Core 호출 실패. Core 는 OPERA 장애를 이미 502 로 정규화해 내려주므로,
 * BE 는 그대로 502 로 올려 FE 가 "외부 시스템 문제" 로 구분할 수 있게 한다.
 */
export class CoreApiError extends HttpException {
  constructor(
    readonly upstreamStatus: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(
      { statusCode: HttpStatus.BAD_GATEWAY, error: 'Bad Gateway', message },
      upstreamStatus === HttpStatus.NOT_FOUND ? HttpStatus.NOT_FOUND : HttpStatus.BAD_GATEWAY,
    );
    this.name = 'CoreApiError';
  }
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
