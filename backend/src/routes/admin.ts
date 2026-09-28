import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deleteUserSessions } from '../auth/session.js';
import { audit, publicUser, requireUser } from '../context.js';
import { clubs, memberships, users } from '../db/schema.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse, Uuid } from '../lib/validate.js';

/** Rotas do administrador da plataforma (quem cuida de todos os clubes). */
export async function adminRoutes(app: FastifyInstance) {
  const { db } = app;

  app.addHook('preHandler', async (req) => {
    if (!requireUser(req).isPlatformAdmin) throw forbidden();
  });

  app.get('/admin/clubs', async () => {
    const rows = await db.select({
      id: clubs.id, name: clubs.name, slug: clubs.slug, church: clubs.church, region: clubs.region, createdAt: clubs.createdAt,
      members: sql<number>`(select count(*)::int from ${memberships} where ${memberships.clubId} = ${clubs.id} and ${memberships.status} = 'ativo')`,
    }).from(clubs).orderBy(clubs.name);
    return { clubs: rows };
  });

  app.get('/admin/users', async (req) => {
    const q = parse(z.object({ q: z.string().trim().max(80).optional() }), req.query);
    const rows = await db.select().from(users)
      .where(q.q ? sql`(lower(${users.username}) like ${'%' + q.q.toLowerCase() + '%'} or lower(${users.name}) like ${'%' + q.q.toLowerCase() + '%'})` : undefined)
      .orderBy(users.name).limit(100);
    return { users: rows.map((u) => ({ ...publicUser(u), disabledAt: u.disabledAt })) };
  });

  app.patch('/admin/users/:userId', async (req) => {
    const me = requireUser(req);
    const id = parse(Uuid, (req.params as { userId: string }).userId);
    const body = parse(z.object({ disabled: z.boolean().optional(), isPlatformAdmin: z.boolean().optional() }).strict(), req.body);
    if (id === me.id) throw badRequest('Você não pode alterar a própria conta por aqui.');
    const [u] = await db.update(users).set({
      ...(body.disabled !== undefined ? { disabledAt: body.disabled ? new Date() : null } : {}),
      ...(body.isPlatformAdmin !== undefined ? { isPlatformAdmin: body.isPlatformAdmin } : {}),
      updatedAt: new Date(),
    }).where(eq(users.id, id)).returning();
    if (!u) throw notFound('Conta não encontrada.');
    if (body.disabled) await deleteUserSessions(db, u.id);
    await audit(db, { actorId: me.id, action: 'admin.user.update', targetId: u.id, data: body });
    return { user: { ...publicUser(u), disabledAt: u.disabledAt } };
  });
}
