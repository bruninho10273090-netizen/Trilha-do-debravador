import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { assertActive } from './billing/service.js';
import type { Tx } from './db/index.js';
import { auditLog, clubs, memberships, units, users, type Membership, type User } from './db/schema.js';
import { forbidden, notFound, unauthorized } from './lib/errors.js';
import { parse, Uuid } from './lib/validate.js';
import { can, type ClubCtx, type Permission } from './permissions.js';

export function requireUser(req: FastifyRequest): User {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}

/**
 * Carrega o clube e o vínculo de quem chama. Quem não é membro ativo recebe 404,
 * para não revelar que o clube existe. Gravações (tudo que não é GET) exigem a
 * assinatura em dia, exceto nas rotas marcadas com `allowInactive` (renovar, sair...).
 */
export async function clubCtx(req: FastifyRequest, clubId: unknown, perm: Permission = 'club.view', opts: { allowInactive?: boolean } = {}): Promise<ClubCtx> {
  const user = requireUser(req);
  const id = parse(Uuid, clubId);
  const db = req.server.db;
  const [club] = await db.select().from(clubs).where(eq(clubs.id, id)).limit(1);
  if (!club) throw notFound('Clube não encontrado.');
  const [membership] = await db.select().from(memberships)
    .where(and(eq(memberships.clubId, id), eq(memberships.userId, user.id))).limit(1);
  const ctx: ClubCtx = { user, club, membership: membership ?? null };
  if (!can(ctx, 'club.view')) throw notFound('Clube não encontrado.');
  if (!can(ctx, perm)) throw forbidden();
  if (req.method !== 'GET' && !opts.allowInactive && !user.isPlatformAdmin) await assertActive(db, club.id);
  return ctx;
}

/** Busca um vínculo do clube (com a conta), ou 404. */
export async function loadMember(db: Tx, clubId: string, membershipId: unknown) {
  const id = parse(Uuid, membershipId);
  const [row] = await db.select({ m: memberships, u: users }).from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.id, id), eq(memberships.clubId, clubId))).limit(1);
  if (!row) throw notFound('Membro não encontrado.');
  return row;
}

export async function assertUnit(db: Tx, clubId: string, unitId: string | null | undefined) {
  if (!unitId) return;
  const [u] = await db.select({ id: units.id }).from(units).where(and(eq(units.id, unitId), eq(units.clubId, clubId))).limit(1);
  if (!u) throw notFound('Unidade não encontrada neste clube.');
}

export async function audit(db: Tx, e: { clubId?: string | null; actorId?: string | null; action: string; targetId?: string | null; data?: unknown }) {
  await db.insert(auditLog).values({
    clubId: e.clubId ?? null, actorId: e.actorId ?? null, action: e.action, targetId: e.targetId ?? null, data: e.data ?? null,
  });
}

const profile = (u: User) => ({
  phone: u.phone, city: u.city, state: u.state, guardianName: u.guardianName, guardianPhone: u.guardianPhone,
});

export const publicUser = (u: User) => ({
  id: u.id, username: u.username, name: u.name, email: u.email, birth: u.birth, ...profile(u),
  isPlatformAdmin: u.isPlatformAdmin, createdAt: u.createdAt,
});

/** Visão completa de um membro, para a liderança (inclui contato e responsável). */
export const memberView = (m: Membership, u: User, ownerId?: string) => ({
  id: m.id, clubId: m.clubId, userId: u.id, username: u.username, name: u.name, birth: u.birth, email: u.email,
  ...profile(u), role: m.role, status: m.status, unitId: m.unitId, classId: m.classId,
  isAdmin: ownerId ? u.id === ownerId : undefined,
  approvedAt: m.approvedAt, createdAt: m.createdAt,
});
