import { Throttle } from '@nestjs/throttler';

/**
 * Login-specific limit.
 *
 * Authentication attracts brute force immediately. The global limit (120 a minute)
 * still allows thousands of password guesses, so login is bounded far more tightly.
 *
 * Ten attempts in five minutes. A few human typos pass; automated attempts do not.
 *
 * The name must match the one declared in ThrottlerModule.forRoot — an unknown name
 * matches no configuration and is silently ignored. Here `default` is overridden,
 * narrowed for this route only.
 */
export const LoginThrottle = () => Throttle({ default: { limit: 10, ttl: 300_000 } });
