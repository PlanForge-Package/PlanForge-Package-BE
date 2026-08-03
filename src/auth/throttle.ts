import { Throttle } from '@nestjs/throttler';

/**
 * 로그인 전용 제한.
 *
 * 인증이 생기면 곧바로 무차별 대입이 따라온다. 전역 제한(분당 120회)만으로는
 * 비밀번호를 수천 번 시도하기에 충분하므로, 로그인만 훨씬 좁게 잡는다.
 *
 * 5분에 10회. 사람이 오타를 몇 번 내는 것은 통과하지만 자동화된 시도는 막힌다.
 *
 * 이름은 반드시 ThrottlerModule.forRoot 에 선언된 것과 같아야 한다 —
 * 없는 이름을 쓰면 어떤 설정에도 매칭되지 않아 조용히 무시된다. 여기서는
 * `default` 를 이 라우트에 한해 좁히는 방식으로 덮어쓴다.
 */
export const LoginThrottle = () => Throttle({ default: { limit: 10, ttl: 300_000 } });
