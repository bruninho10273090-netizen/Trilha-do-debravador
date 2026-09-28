import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deleteUserSessions } from '../auth/session.js';
import { markInvoicePaid } from '../billing/service.js';
import { subscriptionState } from '../billing/state.js';
import { audit, publicUser, requireUser } from '../context.js';
import { clubs, invoices, memberships, plans, subscriptions, users } from '../db/schema.js';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../lib/errors.js';
import { parse, Uuid } from '../lib/validate.js';

const PlanBody = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().trim().min(2).max(80),
  interval: z.enum(['mensal', 'anual']),
  priceCents: z.number().int().min(0),
  maxMembers: z.number().int().min(1).nullable().optional(),
  active: z.boolean().optional(),
});

/** Rotas do administrador da plataforma (quem vende as assinaturas e cuida de todos os clubes). */
export async function adminRoutes(app: FastifyInstance) {
  const { db } = app;

  app.addHook('preHandler', async (req) => {
    if (!requireUser(req).isPlatformAdmin) throw forbidden();
  });

  app.get('/admin/clubs', async () => {
    const rows = await db.select({
      club: { id: clubs.id, name: clubs.name, slug: clubs.slug, church: clubs.church, region: clubs.region, createdAt: clubs.createdAt },
      admin: { id: users.id, name: users.name, username: users.username, email: users.email, phone: users.phone },
      sub: subscriptions,
      members: sql<number>`(select count(*)::int from ${memberships} where ${memberships.clubId} = ${clubs.id} and ${memberships.status} = 'ativo')`,
    }).from(clubs)
      .innerJoin(users, eq(users.id, clubs.ownerId))
      .leftJoin(subscriptions, eq(subscriptions.clubId, clubs.id))
      .orderBy(clubs.name);
    return {
      clubs: rows.map((r) => ({ ...r.club, admin: r.admin, members: r.members, subscription: { ...subscriptionState(r.sub), planId: r.sub?.planId ?? null } })),
    };
  });

  /* ---------- planos ---------- */

  app.get('/admin/plans', async () => ({ plans: await db.select().from(plans).orderBy(plans.interval, plans.priceCents) }));

  app.post('/admin/plans', async (req, reply) => {
    const me = requireUser(req);
    const body = parse(PlanBody, req.body);
    try {
      const [p] = await db.insert(plans).values({ ...body, maxMembers: body.maxMembers ?? null }).returning();
      await audit(db, { actorId: me.id, action: 'admin.plan.create', targetId: p.id, data: body });
      return reply.status(201).send({ plan: p });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Já existe um plano com esse código.');
      throw e;
    }
  });

  /** Preço e intervalo novos valem para as próximas faturas; as já emitidas não mudam. */
  app.patch('/admin/plans/:planId', async (req) => {
    const me = requireUser(req);
    const id = parse(Uuid, (req.params as { planId: string }).planId);
    const body = parse(PlanBody.partial(), req.body);
    const [p] = await db.update(plans).set(body).where(eq(plans.id, id)).returning();
    if (!p) throw notFound('Plano não encontrado.');
    await audit(db, { actorId: me.id, action: 'admin.plan.update', targetId: p.id, data: body });
    return { plan: p };
  });

  /* ---------- faturas e assinaturas ---------- */

  app.get('/admin/invoices', async (req) => {
    const q = parse(z.object({ status: z.enum(['pendente', 'paga', 'cancelada', 'estornada']).optional() }), req.query);
    const rows = await db.select({ inv: invoices, clubId: clubs.id, clubName: clubs.name, billingName: subscriptions.billingName })
      .from(invoices)
      .innerJoin(subscriptions, eq(subscriptions.id, invoices.subscriptionId))
      .innerJoin(clubs, eq(clubs.id, subscriptions.clubId))
      .where(q.status ? eq(invoices.status, q.status) : undefined)
      .orderBy(desc(invoices.createdAt)).limit(200);
    return { invoices: rows.map((r) => ({ ...r.inv, club: { id: r.clubId, name: r.clubName }, billingName: r.billingName })) };
  });

  /** Confirma um pagamento recebido fora do sistema (PIX, transferência...). */
  app.post('/admin/invoices/:invoiceId/paid', async (req) => {
    const me = requireUser(req);
    const id = parse(Uuid, (req.params as { invoiceId: string }).invoiceId);
    const body = parse(z.object({ reference: z.string().trim().max(200).optional() }), req.body);
    const inv = await db.transaction(async (tx) => {
      const paid = await markInvoicePaid(tx, id, body.reference);
      await audit(tx, { actorId: me.id, action: 'admin.invoice.paid', targetId: paid.id });
      return paid;
    });
    return { invoice: inv };
  });

  /** Ajuste manual da assinatura (cortesia, prorrogação, correção). */
  app.patch('/admin/clubs/:clubId/subscription', async (req) => {
    const me = requireUser(req);
    const clubId = parse(Uuid, (req.params as { clubId: string }).clubId);
    const body = parse(z.object({
      status: z.enum(['trial', 'ativa', 'cancelada']).optional(),
      planId: Uuid.nullable().optional(),
      trialEndsAt: z.iso.datetime().optional(),
      currentPeriodEnd: z.iso.datetime().optional(),
    }).strict(), req.body);
    if (body.status === 'ativa' && !body.currentPeriodEnd) throw badRequest('Informe até quando a assinatura fica ativa.');
    const [s] = await db.update(subscriptions).set({
      status: body.status, planId: body.planId,
      trialEndsAt: body.trialEndsAt ? new Date(body.trialEndsAt) : undefined,
      currentPeriodEnd: body.currentPeriodEnd ? new Date(body.currentPeriodEnd) : undefined,
      updatedAt: new Date(),
    }).where(eq(subscriptions.clubId, clubId)).returning();
    if (!s) throw notFound('Assinatura não encontrada.');
    await audit(db, { clubId, actorId: me.id, action: 'admin.subscription.update', data: body });
    return { subscription: { ...s, ...subscriptionState(s) } };
  });

  /* ---------- contas ---------- */

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
