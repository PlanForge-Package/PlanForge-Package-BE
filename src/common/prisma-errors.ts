import { Prisma } from '@prisma/client';

/**
 * Whether a Prisma error is a unique constraint violation.
 *
 * A duplicate is something the caller can fix — a code already taken, an email already
 * registered — so it has to be told apart from a real failure and answered with 409
 * rather than 500.
 *
 * `field` narrows it to one column, for a table with several unique constraints.
 * `meta.target` cannot be trusted for that: Prisma 6.19 sometimes reports
 * "(not available)" instead of the column names, so a missing target counts as a match
 * rather than letting the violation slip through as a 500.
 */
export function isUniqueViolation(error: unknown, field?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  if (!field) return true;

  const target = error.meta?.target;
  if (typeof target === 'string') return target.includes(field);
  if (Array.isArray(target)) return target.some((column) => String(column).includes(field));

  return true;
}
