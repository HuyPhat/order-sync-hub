import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Transaction } from 'sequelize';
import { UnauthorizedError } from '../auth/errors.js';
import type { AuthUser } from '../auth/token.js';
import { sequelize } from '../db/sequelize.js';
import { RefreshToken, User } from '../models/index.js';

export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 3600;
// A client may send the same refresh token twice within moments (parallel requests that all got a
// 401, a retry after a lost response). A token used less than this long ago is accepted again;
// after that, seeing it means it was copied, so the whole family is revoked.
// ponytail: inside the window a stolen token is also accepted; shrink it if clients single-flight.
export const REFRESH_GRACE_SECONDS = 10;

// 32 random bytes are unguessable, so a fast hash is enough (no salt, no argon2) and it keeps the
// lookup by hash a plain unique-index read.
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

async function insertToken(
  userId: number,
  familyId: string,
  transaction: Transaction | null = null,
) {
  const token = randomBytes(32).toString('base64url');
  await RefreshToken.create(
    {
      userId,
      familyId,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    },
    { transaction },
  );
  return token;
}

const revokeFamily = (familyId: string, transaction: Transaction | null = null) =>
  RefreshToken.update(
    { revokedAt: new Date() },
    { where: { familyId, revokedAt: null }, transaction },
  );

// Starts a new session (family) for a user who has just logged in.
export const createRefreshToken = (userId: number): Promise<string> =>
  insertToken(userId, randomUUID());

// Swaps a refresh token for a new one in the same family, and reports the user as stored NOW, so
// the new access token carries the current role. Every failure is the same 401.
export async function rotateRefreshToken(
  token: string,
): Promise<{ user: AuthUser; refreshToken: string }> {
  const result = await sequelize.transaction(async (transaction) => {
    // FOR UPDATE: two requests with the same token take turns instead of both reading "unused".
    const row = await RefreshToken.findOne({
      where: { tokenHash: hash(token) },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;

    if (row.usedAt) {
      const usedAgoMs = Date.now() - row.usedAt.getTime();
      if (usedAgoMs >= REFRESH_GRACE_SECONDS * 1000) {
        await revokeFamily(row.familyId, transaction);
        return null; // committed, so the revocation sticks even though the request fails
      }
    } else {
      await row.update({ usedAt: new Date() }, { transaction });
    }

    const user = await User.findByPk(row.userId, { transaction });
    if (!user) return null;
    return {
      user: { id: user.id, role: user.role },
      refreshToken: await insertToken(user.id, row.familyId, transaction),
    };
  });
  if (!result) throw new UnauthorizedError('Invalid refresh token');
  return result;
}

// Ends the session the token belongs to. An unknown token is ignored: logout never says whether a
// token existed.
export async function revokeRefreshToken(token: string): Promise<void> {
  const row = await RefreshToken.findOne({ where: { tokenHash: hash(token) } });
  if (row) await revokeFamily(row.familyId);
}
