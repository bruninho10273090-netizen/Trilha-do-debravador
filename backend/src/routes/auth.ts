import { eq, sql } from 'drizzle-orm';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DUMMY_HASH, hashPassword, isLegacyHash, verifyPassword } from '../auth/password.js';
import { createSession, deleteSession, deleteUserSessions } from '../auth/session.js';
import { audit, publicUser, requireUser } from '../context.js';
import { clubLogos, clubs, memberships, users } from '../db/schema.js';
import { badRequest, conflict, forbidden, isUniqueViolation, unauthorized } from '../lib/errors.js';
import { BirthDate, parse, Password, PersonName, ProfileFields, Username } from '../lib/validate.js';

const Email = z.email().max(200).transform((e) => e.toLowerCase());

const Register = z.object({
  username: Username, name: PersonName, password: Password,
  email: Email.optional(), birth: BirthDate.optional(), ...ProfileFields,
});
const Login = z.object({ username: z.string().trim().toLowerCase().min(1).max(200), password: z.string().min(1).max(200) });
const UpdateMe = z.object({
  name: PersonName.optional(), email: Email.nullable().optional(), birth: BirthDate.nullable().optional(), ...ProfileFields,
}).strict();
const ChangePassword = z.object({ current: z.string().min(1), password: Password });

const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

export async function authRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.post('/auth/register', authLimit, async (req, reply) => {
    const body = parse(Register, req.body);
    try {
      const { password, ...data } = body;
      const [user] = await db.insert(users).values({ ...data, passwordHash: await hashPassword(password) }).returning();
      const s = await createSession(db, user.id, config.sessionDays, meta(req));
      return reply.status(201).send({ token: s.token, expiresAt: s.expiresAt, user: publicUser(user) });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Esse usuário ou e-mail já está em uso.');
      throw e;
    }
  });

  app.post('/auth/login', authLimit, async (req) => {
    const body = parse(Login, req.body);
    // aceita usuário ou e-mail
    const [user] = await db.select().from(users)
      .where(body.username.includes('@') ? sql`lower(${users.email}) = ${body.username}` : sql`lower(${users.username}) = ${body.username}`)
      .limit(1);
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || user.disabledAt) throw unauthorized('Usuário ou senha incorretos.');
    // senha trazida do app antigo: passa para o formato atual agora que sabemos a senha
    if (isLegacyHash(user.passwordHash)) {
      await db.update(users).set({ passwordHash: await hashPassword(body.password) }).where(eq(users.id, user.id));
    }
    const s = await createSession(db, user.id, config.sessionDays, meta(req));
    return { token: s.token, expiresAt: s.expiresAt, user: publicUser(user) };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth) await deleteSession(db, req.auth.sessionId);
    return reply.status(204).send();
  });

  app.get('/auth/me', async (req) => {
    const user = requireUser(req);
    const rows = await db.select({ m: memberships, c: clubs, logo: clubLogos.sha256 }).from(memberships)
      .innerJoin(clubs, eq(clubs.id, memberships.clubId))
      .leftJoin(clubLogos, eq(clubLogos.clubId, clubs.id))
      .where(eq(memberships.userId, user.id))
      .orderBy(clubs.name);
    return {
      user: publicUser(user),
      clubs: rows.map(({ m, c, logo }) => ({
        membershipId: m.id, role: m.role, status: m.status, unitId: m.unitId, classId: m.classId,
        isAdmin: c.ownerId === user.id,
        club: { id: c.id, name: c.name, slug: c.slug, logoUrl: logo ? `/api/clubs/${c.id}/logo?v=${logo.slice(0, 12)}` : null },
      })),
    };
  });

  app.patch('/auth/me', async (req) => {
    const user = requireUser(req);
    const body = parse(UpdateMe, req.body);
    try {
      const [u] = await db.update(users).set({ ...body, updatedAt: new Date() }).where(eq(users.id, user.id)).returning();
      return { user: publicUser(u) };
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Esse e-mail já está em uso.');
      throw e;
    }
  });

  /**
   * Quem instala o servidor define ADMIN_CLAIM_CODE; a conta logada que digitar esse
   * código vira administradora da plataforma. Assim não é preciso acessar o servidor.
   */
  app.post('/auth/claim-admin', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    const user = requireUser(req);
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(200) }), req.body);
    const expected = config.adminClaimCode;
    const digest = (s: string) => createHash('sha256').update(s).digest();
    if (!expected || !timingSafeEqual(digest(code), digest(expected))) throw forbidden('Código incorreto.');
    const [u] = await db.update(users).set({ isPlatformAdmin: true, updatedAt: new Date() }).where(eq(users.id, user.id)).returning();
    await audit(db, { actorId: user.id, action: 'admin.claim', targetId: user.id });
    return { user: publicUser(u) };
  });

  app.post('/auth/password', authLimit, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(ChangePassword, req.body);
    if (!(await verifyPassword(body.current, user.passwordHash))) throw badRequest('A senha atual não confere.');
    await db.update(users).set({ passwordHash: await hashPassword(body.password), updatedAt: new Date() }).where(eq(users.id, user.id));
    await deleteUserSessions(db, user.id, req.auth!.sessionId);
    return reply.status(204).send();
  });
}
