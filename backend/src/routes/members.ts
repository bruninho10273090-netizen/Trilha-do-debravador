import { and, desc, eq, lt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { deleteUserSessions } from '../auth/session.js';
import { ageOf, CLASS_IDS, classForAge } from '../catalog/index.js';
import { assertUnit, audit, clubCtx, loadMember, memberView } from '../context.js';
import { auditLog, memberships, units, users, type Membership } from '../db/schema.js';
import { badRequest, conflict, forbidden, isUniqueViolation } from '../lib/errors.js';
import { BirthDate, parse, Password, PersonName, Username, Uuid } from '../lib/validate.js';
import { can, canManageMember, ROLES } from '../permissions.js';
import { statsFor } from '../services/stats.js';
import { otherActiveDirectors } from './clubs.js';

const Role = z.enum(ROLES as [string, ...string[]]).transform((r) => r as Membership['role']);
const ClassId = z.enum(CLASS_IDS as [string, ...string[]]);

const ListQuery = z.object({
  status: z.enum(['pendente', 'ativo', 'inativo']).optional(),
  role: Role.optional(),
  unitId: Uuid.optional(),
});
const CreateMember = z.object({
  username: Username, name: PersonName, password: Password, role: Role,
  unitId: Uuid.nullable().optional(), birth: BirthDate.optional(), classId: ClassId.optional(),
});
const UpdateMember = z.object({
  role: Role.optional(),
  status: z.enum(['ativo', 'inativo']).optional(),
  unitId: Uuid.nullable().optional(),
  classId: ClassId.nullable().optional(),
});
const ResetPassword = z.object({ password: Password });

type P = { clubId: string; memberId: string };

export async function memberRoutes(app: FastifyInstance) {
  const { db } = app;

  /** Liderança vê todos (com XP); desbravador vê só os membros ativos, sem dados pessoais. */
  app.get('/clubs/:clubId/members', async (req) => {
    const ctx = await clubCtx(req, (req.params as P).clubId);
    const q = parse(ListQuery, req.query);
    const full = can(ctx, 'members.viewAll');
    const rows = await db.select({ m: memberships, u: users }).from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(
        eq(memberships.clubId, ctx.club.id),
        full ? (q.status ? eq(memberships.status, q.status) : undefined) : eq(memberships.status, 'ativo'),
        q.role ? eq(memberships.role, q.role) : undefined,
        q.unitId ? eq(memberships.unitId, q.unitId) : undefined,
      ))
      .orderBy(users.name);
    const stats = await statsFor(db, { membershipIds: rows.filter((r) => r.m.role === 'desbravador').map((r) => r.m.id) });
    return {
      members: rows.map(({ m, u }) => {
        const s = stats.get(m.id);
        const base = full ? memberView(m, u)
          : { id: m.id, name: u.name, username: u.username, role: m.role, status: m.status, unitId: m.unitId, classId: m.classId };
        return { ...base, stats: s ? { xp: s.xp, level: s.level, title: s.title, approved: s.approved, pending: s.pending, espDone: s.espDone } : null };
      }),
    };
  });

  /** Diretoria cadastra alguém direto (ex.: desbravador sem e-mail). A conta nasce ativa no clube. */
  app.post('/clubs/:clubId/members', { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const ctx = await clubCtx(req, (req.params as P).clubId, 'members.manage');
    const body = parse(CreateMember, req.body);
    if (!ctx.user.isPlatformAdmin && ctx.membership!.role === 'associado' && body.role === 'diretor') {
      throw forbidden('Só o diretor pode cadastrar outro diretor.');
    }
    await assertUnit(db, ctx.club.id, body.unitId);
    try {
      const out = await db.transaction(async (tx) => {
        const [u] = await tx.insert(users).values({
          username: body.username, name: body.name, birth: body.birth ?? null, passwordHash: await hashPassword(body.password),
        }).returning();
        const [m] = await tx.insert(memberships).values({
          clubId: ctx.club.id, userId: u.id, role: body.role, status: 'ativo', unitId: body.unitId ?? null,
          classId: body.role === 'desbravador' ? (body.classId ?? classForAge(ageOf(body.birth))) : null,
          approvedBy: ctx.user.id, approvedAt: new Date(),
        }).returning();
        await audit(tx, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'member.create', targetId: m.id, data: { username: u.username, role: m.role } });
        return memberView(m, u);
      });
      return reply.status(201).send({ member: out });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Esse nome de usuário já existe. Se a pessoa já tem conta, envie o código do clube para ela entrar.');
      throw e;
    }
  });

  app.get('/clubs/:clubId/members/:memberId', async (req) => {
    const p = req.params as P;
    const ctx = await clubCtx(req, p.clubId);
    const { m, u } = await loadMember(db, ctx.club.id, p.memberId);
    const self = ctx.membership?.id === m.id;
    if (!self && !can(ctx, 'members.viewAll')) throw forbidden();
    const s = m.role === 'desbravador' ? (await statsFor(db, { membershipIds: [m.id] })).get(m.id) : null;
    return { member: { ...memberView(m, u), stats: s ?? null } };
  });

  app.patch('/clubs/:clubId/members/:memberId', async (req) => {
    const p = req.params as P;
    const ctx = await clubCtx(req, p.clubId);
    const body = parse(UpdateMember, req.body);
    const { m, u } = await loadMember(db, ctx.club.id, p.memberId);
    const self = ctx.membership?.id === m.id;
    const onlyUnit = Object.keys(body).every((k) => k === 'unitId');

    // o próprio desbravador pode escolher a unidade uma vez; o resto é com a diretoria
    const selfPicksUnit = self && onlyUnit && m.unitId === null && !can(ctx, 'members.manage');
    if (!selfPicksUnit && !canManageMember(ctx, m, body.role)) throw forbidden();
    if (self && body.status && body.status !== m.status) throw forbidden('Você não pode mudar o próprio status.');
    if (m.status === 'pendente' && body.status) throw badRequest('Use a rota de aprovação para contas pendentes.');
    await assertUnit(db, ctx.club.id, body.unitId);

    const losesDirector = m.role === 'diretor' && m.status === 'ativo' &&
      ((body.role && body.role !== 'diretor') || body.status === 'inativo');
    if (losesDirector && (await otherActiveDirectors(db, ctx.club.id, m.id)) === 0) {
      throw forbidden('O clube precisa de pelo menos um diretor ativo.');
    }

    const role = body.role ?? m.role;
    const classId = role !== 'desbravador' ? null
      : body.classId !== undefined ? body.classId : (m.classId ?? classForAge(ageOf(u.birth)));
    const [updated] = await db.update(memberships)
      .set({ role, status: body.status, unitId: body.unitId, classId, updatedAt: new Date() })
      .where(eq(memberships.id, m.id)).returning();
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'member.update', targetId: m.id, data: body });
    return { member: memberView(updated, u) };
  });

  app.post('/clubs/:clubId/members/:memberId/approve', async (req) => {
    const p = req.params as P;
    const ctx = await clubCtx(req, p.clubId, 'members.manage');
    const { m, u } = await loadMember(db, ctx.club.id, p.memberId);
    if (m.status !== 'pendente') throw badRequest('Essa conta não está pendente.');
    if (!canManageMember(ctx, m)) throw forbidden();
    const [updated] = await db.update(memberships)
      .set({ status: 'ativo', approvedBy: ctx.user.id, approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(memberships.id, m.id)).returning();
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'member.approve', targetId: m.id });
    return { member: memberView(updated, u) };
  });

  /** Remove o vínculo (ou recusa um pedido pendente). A conta da pessoa continua existindo. */
  app.delete('/clubs/:clubId/members/:memberId', async (req, reply) => {
    const p = req.params as P;
    const ctx = await clubCtx(req, p.clubId, 'members.manage');
    const { m } = await loadMember(db, ctx.club.id, p.memberId);
    if (ctx.membership?.id === m.id) throw badRequest('Para sair do clube, use a opção Sair.');
    if (!canManageMember(ctx, m)) throw forbidden();
    if (m.role === 'diretor' && m.status === 'ativo' && (await otherActiveDirectors(db, ctx.club.id, m.id)) === 0) {
      throw forbidden('O clube precisa de pelo menos um diretor ativo.');
    }
    await db.delete(memberships).where(eq(memberships.id, m.id));
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: m.status === 'pendente' ? 'member.reject' : 'member.remove', targetId: m.id });
    return reply.status(204).send();
  });

  /**
   * Diretoria redefine a senha de quem esqueceu. Só vale para contas que pertencem
   * apenas a este clube, para um clube não mexer na conta de alguém de outro.
   */
  app.post('/clubs/:clubId/members/:memberId/password', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = req.params as P;
    const ctx = await clubCtx(req, p.clubId, 'members.manage');
    const body = parse(ResetPassword, req.body);
    const { m, u } = await loadMember(db, ctx.club.id, p.memberId);
    if (!canManageMember(ctx, m) || u.id === ctx.user.id) throw forbidden();
    const [others] = await db.select({ n: sql<number>`count(*)::int` }).from(memberships)
      .where(and(eq(memberships.userId, u.id), ne(memberships.clubId, ctx.club.id)));
    if (others.n > 0 && !ctx.user.isPlatformAdmin) throw forbidden('Essa pessoa participa de outros clubes; ela mesma precisa trocar a senha.');
    if (u.isPlatformAdmin && !ctx.user.isPlatformAdmin) throw forbidden();
    await db.update(users).set({ passwordHash: await hashPassword(body.password), updatedAt: new Date() }).where(eq(users.id, u.id));
    await deleteUserSessions(db, u.id);
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'member.password.reset', targetId: m.id });
    return reply.status(204).send();
  });

  /** Ranking de desbravadores e de unidades (média de XP por membro). */
  app.get('/clubs/:clubId/ranking', async (req) => {
    const ctx = await clubCtx(req, (req.params as P).clubId);
    const rows = await db.select({ id: memberships.id, name: users.name, unitId: memberships.unitId, classId: memberships.classId })
      .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.clubId, ctx.club.id), eq(memberships.role, 'desbravador'), eq(memberships.status, 'ativo')));
    const stats = await statsFor(db, { membershipIds: rows.map((r) => r.id) });
    const members = rows.map((r) => ({ ...r, xp: stats.get(r.id)!.xp, level: stats.get(r.id)!.level, title: stats.get(r.id)!.title }))
      .sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name, 'pt-BR'));
    const us = await db.select().from(units).where(eq(units.clubId, ctx.club.id));
    const unitRank = us.map((u) => {
      const ms = members.filter((m) => m.unitId === u.id);
      const total = ms.reduce((s, m) => s + m.xp, 0);
      return { unitId: u.id, name: u.name, color: u.color, members: ms.length, totalXp: total, avgXp: ms.length ? Math.round(total / ms.length) : 0 };
    }).sort((a, b) => b.avgXp - a.avgXp);
    return { members, units: unitRank };
  });

  app.get('/clubs/:clubId/audit', async (req) => {
    const ctx = await clubCtx(req, (req.params as P).clubId, 'audit.view');
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.iso.datetime().optional() }), req.query);
    const rows = await db.select({ e: auditLog, actorName: users.name }).from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(and(eq(auditLog.clubId, ctx.club.id), q.before ? lt(auditLog.createdAt, new Date(q.before)) : undefined))
      .orderBy(desc(auditLog.createdAt)).limit(q.limit);
    return { entries: rows.map((r) => ({ ...r.e, actorName: r.actorName })) };
  });
}
