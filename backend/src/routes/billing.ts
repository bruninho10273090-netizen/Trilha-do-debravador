import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSubscription, manualProvider, type BillingProvider } from '../billing/service.js';
import { subscriptionState } from '../billing/state.js';
import { audit, clubCtx } from '../context.js';
import { invoices, plans, subscriptions } from '../db/schema.js';
import { normalizeCpfCnpj } from '../lib/document.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse, Uuid } from '../lib/validate.js';

const Checkout = z.object({
  planId: Uuid,
  billingName: z.string().trim().min(2).max(120),
  billingDocument: z.string().transform((s, c) => {
    const d = normalizeCpfCnpj(s);
    if (!d) c.addIssue({ code: 'custom', message: 'CPF ou CNPJ inválido.' });
    return d ?? '';
  }),
  billingEmail: z.email().max(200).transform((e) => e.toLowerCase()),
});

type P = { clubId: string };

export const publicPlan = (p: typeof plans.$inferSelect) => ({
  id: p.id, code: p.code, name: p.name, interval: p.interval, priceCents: p.priceCents, currency: p.currency, maxMembers: p.maxMembers,
});

export async function billingRoutes(app: FastifyInstance, opts: { provider?: BillingProvider } = {}) {
  const { db } = app;
  const provider = opts.provider ?? manualProvider;

  /** Planos à venda (mensal e anual). */
  app.get('/plans', async () => {
    const rows = await db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.priceCents);
    return { plans: rows.map(publicPlan) };
  });

  /** Situação da assinatura do clube e faturas. Só o administrador do clube vê. */
  app.get('/clubs/:clubId/subscription', async (req) => {
    const ctx = await clubCtx(req, (req.params as P).clubId, 'club.billing');
    const sub = await getSubscription(db, ctx.club.id);
    if (!sub) throw notFound('Assinatura não encontrada.');
    const [plan] = sub.planId ? await db.select().from(plans).where(eq(plans.id, sub.planId)) : [];
    const invs = await db.select().from(invoices).where(eq(invoices.subscriptionId, sub.id)).orderBy(desc(invoices.createdAt)).limit(24);
    return { subscription: { ...sub, ...subscriptionState(sub) }, plan: plan ? publicPlan(plan) : null, invoices: invs };
  });

  /**
   * Escolhe o plano (ou troca/renova) e gera a fatura. Funciona mesmo com a assinatura
   * vencida, para o clube conseguir voltar a pagar.
   */
  app.post('/clubs/:clubId/subscription', async (req, reply) => {
    const ctx = await clubCtx(req, (req.params as P).clubId, 'club.billing', { allowInactive: true });
    const body = parse(Checkout, req.body);
    const [plan] = await db.select().from(plans).where(and(eq(plans.id, body.planId), eq(plans.active, true))).limit(1);
    if (!plan) throw notFound('Plano não encontrado.');
    const out = await db.transaction(async (tx) => {
      const sub = (await getSubscription(tx, ctx.club.id))!;
      // uma fatura em aberto por vez: a anterior é cancelada
      await tx.update(invoices).set({ status: 'cancelada' })
        .where(and(eq(invoices.subscriptionId, sub.id), eq(invoices.status, 'pendente')));
      const [updatedSub] = await tx.update(subscriptions).set({
        billingName: body.billingName, billingDocument: body.billingDocument, billingEmail: body.billingEmail,
        provider: provider.name, updatedAt: new Date(),
      }).where(eq(subscriptions.id, sub.id)).returning();
      const [inv] = await tx.insert(invoices).values({
        subscriptionId: sub.id, planId: plan.id, amountCents: plan.priceCents, currency: plan.currency,
        dueAt: new Date(Date.now() + 3 * 864e5), provider: provider.name,
      }).returning();
      const charge = await provider.createCharge({ invoice: inv, plan, subscription: updatedSub });
      const [saved] = await tx.update(invoices).set({ providerRef: charge.providerRef ?? null, paymentUrl: charge.paymentUrl ?? null })
        .where(eq(invoices.id, inv.id)).returning();
      await audit(tx, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'billing.checkout', targetId: inv.id, data: { plan: plan.code } });
      return { invoice: saved, instructions: charge.instructions };
    });
    return reply.status(201).send(out);
  });

  /** Cancela a renovação: o clube continua ativo até o fim do período pago. */
  app.post('/clubs/:clubId/subscription/cancel', async (req) => {
    const ctx = await clubCtx(req, (req.params as P).clubId, 'club.billing', { allowInactive: true });
    const sub = await getSubscription(db, ctx.club.id);
    if (!sub || sub.status !== 'ativa') throw badRequest('Não há assinatura paga para cancelar.');
    const [s] = await db.update(subscriptions).set({ cancelAtPeriodEnd: true, updatedAt: new Date() }).where(eq(subscriptions.id, sub.id)).returning();
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'billing.cancel' });
    return { subscription: { ...s, ...subscriptionState(s) } };
  });

  app.post('/clubs/:clubId/subscription/resume', async (req) => {
    const ctx = await clubCtx(req, (req.params as P).clubId, 'club.billing', { allowInactive: true });
    const sub = await getSubscription(db, ctx.club.id);
    if (!sub?.cancelAtPeriodEnd) throw badRequest('A assinatura não está cancelada.');
    const [s] = await db.update(subscriptions).set({ cancelAtPeriodEnd: false, updatedAt: new Date() }).where(eq(subscriptions.id, sub.id)).returning();
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'billing.resume' });
    return { subscription: { ...s, ...subscriptionState(s) } };
  });
}
