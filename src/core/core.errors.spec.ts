import { HttpStatus } from '@nestjs/common';
import { CoreApiError } from './core.errors';

describe('CoreApiError — 상태 전달', () => {
  // OPERA 가 거절한 사유가 화면까지 닿아야 운영자가 무엇을 고칠지 안다.
  it('400 은 그대로 내려보내고 Core 가 준 사유를 쓴다', () => {
    const error = new CoreApiError(400, '기본 메시지', {
      message: '이미 픽업된 예약이 있는 블록은 취소할 수 없습니다.',
    });

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.getResponse()).toEqual(
      expect.objectContaining({ message: '이미 픽업된 예약이 있는 블록은 취소할 수 없습니다.' }),
    );
  });

  it('409 도 그대로 전달한다', () => {
    const error = new CoreApiError(409, '기본', { message: '이미 쓰고 있는 블록 코드입니다.' });
    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
  });

  // 외부 장애는 재시도해 볼 문제라 502 로 구분되어야 한다.
  it('500 은 502 로 바꾼다', () => {
    const error = new CoreApiError(500, 'Core 호출이 500 로 실패했습니다', {
      message: '내부 오류',
    });
    expect(error.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(error.getResponse()).toEqual(
      expect.objectContaining({ message: 'Core 호출이 500 로 실패했습니다' }),
    );
  });

  // 자격 증명 문제를 사용자에게 401 로 보여 주면 로그인하라는 뜻으로 읽힌다.
  it('401 은 502 로 감춘다', () => {
    const error = new CoreApiError(401, '기본', { message: 'API 키가 올바르지 않습니다.' });
    expect(error.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(error.getResponse()).toEqual(expect.objectContaining({ message: '기본' }));
  });

  it('본문에 사유가 없으면 기본 메시지를 쓴다', () => {
    const error = new CoreApiError(400, '기본 메시지', 'plain text body');
    expect(error.getResponse()).toEqual(expect.objectContaining({ message: '기본 메시지' }));
  });
});
