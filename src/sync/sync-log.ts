import { Prisma, SyncDirection, SyncStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/** What is being delegated, and against which record. */
export interface SyncLogEntry {
  /** Domain the write belongs to: Reservation, Folio, Block, Room, Profile, RatePlan. */
  entity: string;
  /** The record it targets. Null when OPERA has not assigned an id yet. */
  entityId: string | null;
  /** What we are sending. Kept so a failure shows the request, not just the error. */
  payload?: unknown;
}

/**
 * Wraps one delegation to OPERA in a SyncLog row.
 *
 * Seven services had this same pending/success/failed dance copied out. Writing what
 * we are about to send *before* the call is the point: when OPERA times out, the row
 * is the only record of the request, and a retry has something to replay.
 *
 * The log is bookkeeping, so a failure to close it never masks the real error — the
 * original exception is always what surfaces.
 */
export async function withSyncLog<T>(
  prisma: PrismaService,
  entry: SyncLogEntry,
  call: () => Promise<T>,
): Promise<T> {
  const log = await prisma.syncLog.create({
    data: {
      entity: entry.entity,
      entityId: entry.entityId,
      direction: SyncDirection.PUSH,
      status: SyncStatus.PENDING,
      payload: (entry.payload ?? {}) as Prisma.InputJsonValue,
    },
  });

  try {
    const result = await call();
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: SyncStatus.SUCCESS, finishedAt: new Date() },
    });
    return result;
  } catch (error) {
    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: SyncStatus.FAILED,
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

/**
 * Opens the log row before the call goes out.
 *
 * Written first on purpose: when OPERA times out, this row is the only record that
 * the request was ever made, and a retry has the payload to replay.
 */
export function startSyncLog(
  prisma: PrismaService,
  entity: string,
  entityId: string | null,
  payload: unknown,
) {
  return prisma.syncLog.create({
    data: {
      entity,
      entityId,
      direction: SyncDirection.PUSH,
      status: SyncStatus.PENDING,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

export interface FinishSyncLogOptions {
  /** The id OPERA assigned, when it was only known after the call returned. */
  entityId?: string | null;
  error?: unknown;
  /** Called with the failure message so the service can log it in its own words. */
  warn?: (message: string) => void;
}

/** Closes the log row. Success and failure both land here so no row stays PENDING. */
export async function finishSyncLog(
  prisma: PrismaService,
  id: string,
  status: SyncStatus,
  options: FinishSyncLogOptions = {},
): Promise<void> {
  const { entityId, error, warn } = options;
  const message = error instanceof Error ? error.message : error ? String(error) : null;
  if (message) warn?.(message);

  await prisma.syncLog.update({
    where: { id },
    data: {
      status,
      finishedAt: new Date(),
      ...(entityId ? { entityId } : {}),
      ...(message ? { error: message } : {}),
    },
  });
}
