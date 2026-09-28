import type { Plan, Subscription } from '../db/schema.js';

/** Dias de tolerância depois do vencimento antes de bloquear o clube. */
export const GRACE_DAYS = 5;
const DAY = 864e5;

export type SubscriptionState = 'trial' | 'ativa' | 'em_atraso' | 'cancelada' | 'expirada';

/**
 * Estado efetivo da assinatura agora. `active` diz se o clube pode gravar dados;
 * com a assinatura vencida o clube continua visível, só para leitura.
 */
export function subscriptionState(sub: Subscription | null | undefined, now = new Date()): { state: SubscriptionState; active: boolean; endsAt: Date | null } {
  if (!sub) return { state: 'expirada', active: false, endsAt: null };
  const t = now.getTime();
  if (sub.status === 'trial') {
    const end = sub.trialEndsAt;
    return end && end.getTime() > t ? { state: 'trial', active: true, endsAt: end } : { state: 'expirada', active: false, endsAt: end };
  }
  const end = sub.currentPeriodEnd;
  if (!end) return { state: 'expirada', active: false, endsAt: null };
  if (end.getTime() > t) return { state: sub.status === 'cancelada' || sub.cancelAtPeriodEnd ? 'cancelada' : 'ativa', active: true, endsAt: end };
  if (sub.status === 'ativa' && !sub.cancelAtPeriodEnd && end.getTime() + GRACE_DAYS * DAY > t) return { state: 'em_atraso', active: true, endsAt: end };
  return { state: sub.status === 'cancelada' || sub.cancelAtPeriodEnd ? 'cancelada' : 'expirada', active: false, endsAt: end };
}

/** Fim do período pago a partir de `start`, conforme o plano. */
export function periodEnd(start: Date, plan: Pick<Plan, 'interval'>) {
  const d = new Date(start);
  if (plan.interval === 'anual') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}
