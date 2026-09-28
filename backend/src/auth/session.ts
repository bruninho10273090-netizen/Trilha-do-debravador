import { and, eq, gt, lt, ne } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';
import { sessions, users, type User } from '../db/schema.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const TOUCH_EVERY_MS = 60 * 60 * 1000;

export async function createSession(db: Db, userId: string, days: number, meta: { ip?: string; userAgent?: string }) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + days * 864e5);
  await db.insert(sessions).values({
    userId, tokenHash: sha256(token), expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300),
  });
  return { token, expiresAt };
}

/** Resolve o token; renova a validade (janela deslizante) no máximo uma vez por hora. */
export async function resolveSession(db: Db, token: string, days: number): Promise<{ user: User; sessionId: string } | null> {
  const [row] = await db.select({ session: sessions, user: users }).from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || row.user.disabledAt) return null;
  if (Date.now() - row.session.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await db.update(sessions)
      .set({ lastUsedAt: new Date(), expiresAt: new Date(Date.now() + days * 864e5) })
      .where(eq(sessions.id, row.session.id));
  }
  return { user: row.user, sessionId: row.session.id };
}

export async function deleteSession(db: Db, sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function deleteUserSessions(db: Db, userId: string, exceptSessionId?: string) {
  await db.delete(sessions).where(and(
    eq(sessions.userId, userId),
    exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined,
  ));
}

export async function purgeExpiredSessions(db: Db) {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
