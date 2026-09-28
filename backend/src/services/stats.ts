import { eq, inArray } from 'drizzle-orm';
import { computeStats } from '../catalog/index.js';
import type { Tx } from '../db/index.js';
import { memberships, requirementProgress, specialtyProgress } from '../db/schema.js';

export type MemberStats = ReturnType<typeof computeStats>;

/** XP e nível de cada vínculo pedido (ou de todos os desbravadores do clube). */
export async function statsFor(db: Tx, opts: { clubId?: string; membershipIds?: string[] }): Promise<Map<string, MemberStats>> {
  let ids = opts.membershipIds ?? [];
  if (opts.clubId) {
    const rows = await db.select({ id: memberships.id }).from(memberships).where(eq(memberships.clubId, opts.clubId));
    ids = rows.map((r) => r.id);
  }
  const out = new Map<string, MemberStats>();
  if (!ids.length) return out;
  const reqs = await db.select({ m: requirementProgress.membershipId, itemKey: requirementProgress.itemKey, status: requirementProgress.status })
    .from(requirementProgress).where(inArray(requirementProgress.membershipId, ids));
  const esps = await db.select({ m: specialtyProgress.membershipId, specialtyId: specialtyProgress.specialtyId, status: specialtyProgress.status })
    .from(specialtyProgress).where(inArray(specialtyProgress.membershipId, ids));
  for (const id of ids) out.set(id, computeStats(reqs.filter((r) => r.m === id), esps.filter((e) => e.m === id)));
  return out;
}
