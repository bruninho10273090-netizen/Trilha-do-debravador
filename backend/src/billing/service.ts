import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { invoices, memberships, plans, subscriptions, type Invoice, type Plan, type Subscription } from '../db/schema.js';
import { HttpError, notFound } from '../lib/errors.js';
import { periodEnd, subscriptionState } from './state.js';

/**
 * Integração com o meio de pagamento. O provedor "manual" só registra a fatura; a
 * administração da plataforma confirma o pagamento. Um gateway (Asaas, Mercado Pago,
 * Stripe…) implementa esta mesma interface e confirma pelo webhook com `markInvoicePaid`.
 */
export interface BillingProvider {
  name: string;
  createCharge(input: { invoice: Invoice; plan: Plan; subscription: Subscription }): Promise<{ providerRef?: string; paymentUrl?: string; instructions: string }>;
}

export const manualProvider: BillingProvider = {
  name: 'manual',
  async createCharge() {
    return { instructions: 'Fatura registrada. O acesso é liberado assim que a administração confirmar o pagamento.' };
  },
};

const paymentRequired = (message: string) => new HttpError(402, 'subscription_inactive', message);

export async function getSubscription(db: Tx, clubId: string) {
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.clubId, clubId)).limit(1);
  return sub ?? null;
}

/** Bloqueia gravações quando a assinatura venceu. */
export async function assertActive(db: Tx, clubId: string) {
  const s = subscriptionState(await getSubscription(db, clubId));
  if (!s.active) throw paymentRequired('A assinatura do clube venceu. O administrador precisa renová-la para voltar a salvar.');
}

/** Respeita o limite de membros do plano (o teste grátis não tem limite). */
export async function assertMemberRoom(db: Tx, clubId: string) {
  const sub = await getSubscription(db, clubId);
  if (!sub?.planId || sub.status === 'trial') return;
  const [plan] = await db.select().from(plans).where(eq(plans.id, sub.planId)).limit(1);
  if (!plan?.maxMembers) return;
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(memberships)
    .where(and(eq(memberships.clubId, clubId), sql`${memberships.status} <> 'inativo'`));
  if (r.n >= plan.maxMembers) throw paymentRequired(`O plano do clube permite até ${plan.maxMembers} membros. Troque de plano para adicionar mais.`);
}

/**
 * Registra o pagamento de uma fatura: a assinatura fica ativa e o período avança
 * (a partir do fim do período atual, se ainda estiver valendo).
 */
export async function markInvoicePaid(db: Tx, invoiceId: string, providerRef?: string) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!inv) throw notFound('Fatura não encontrada.');
  if (inv.status === 'paga') return inv;
  if (inv.status !== 'pendente') throw new HttpError(400, 'bad_request', 'Essa fatura não está pendente.');
  const [plan] = await db.select().from(plans).where(eq(plans.id, inv.planId)).limit(1);
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, inv.subscriptionId)).limit(1);
  const now = new Date();
  const cur = sub.status !== 'trial' && sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
  const end = periodEnd(cur, plan);
  const [paid] = await db.update(invoices)
    .set({ status: 'paga', paidAt: now, periodStart: cur, periodEnd: end, providerRef: providerRef ?? inv.providerRef })
    .where(eq(invoices.id, inv.id)).returning();
  await db.update(subscriptions).set({
    status: 'ativa', planId: plan.id, currentPeriodStart: cur, currentPeriodEnd: end,
    cancelAtPeriodEnd: false, updatedAt: now,
  }).where(eq(subscriptions.id, sub.id));
  return paid;
}
