import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { PosOutlet } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { unauthorized } from '../common/errors';

/** Header carrying the key. Not Authorization, to keep it from mixing with JWTs. */
export const POS_KEY_HEADER = 'x-pos-key';

/** Key prefix. It narrows the candidates; the rest is checked with bcrypt. */
export const POS_KEY_PREFIX = 'pos_';

/** How many leading characters are kept so screens and logs can tell keys apart. */
export const POS_KEY_PREFIX_LENGTH = 12;

export interface PosRequest extends Request {
  outlet: PosOutlet;
}

/**
 * POS outlet authentication.
 *
 * No staff JWT. It would put a staff password in the terminal and give that terminal
 * every staff permission. Each outlet gets its own key, valid only on routes carrying
 * this guard.
 *
 * Keys are stored as bcrypt hashes only. A database leak does not leak the keys.
 */
@Injectable()
export class PosKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PosRequest>();
    const raw = request.header(POS_KEY_HEADER);

    if (!raw || !raw.startsWith(POS_KEY_PREFIX)) {
      throw unauthorized('POS_KEY_MALFORMED');
    }

    /*
     * The prefix narrows the candidates.
     *
     * Comparing every key with bcrypt runs one hash per outlet and makes a single room
     * charge take hundreds of milliseconds. The prefix is not secret, so indexing is safe.
     */
    const prefix = raw.slice(0, POS_KEY_PREFIX_LENGTH);
    const candidates = await this.prisma.posOutlet.findMany({
      where: { apiKeyPrefix: prefix, active: true },
    });

    for (const outlet of candidates) {
      if (await bcrypt.compare(raw, outlet.apiKeyHash)) {
        request.outlet = outlet;
        // Last-used time is the only clue for finding a dead terminal. A failure never fails the request.
        void this.prisma.posOutlet
          .update({ where: { id: outlet.id }, data: { lastUsedAt: new Date() } })
          .catch(() => undefined);
        return true;
      }
    }

    // An inactive outlet and an unknown key are not told apart — it would guide key hunting.
    throw unauthorized('POS_KEY_INVALID');
  }
}
