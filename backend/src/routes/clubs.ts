import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { assertActive, assertMemberRoom, getSubscription } from '../billing/service.js';
import { subscriptionState } from '../billing/state.js';
import { ageOf, classForAge } from '../catalog/index.js';
import { assertUnit, audit, clubCtx, loadMember, requireUser } from '../context.js';
import { clubLogos, clubs, DEFAULT_CLUB_SETTINGS, memberships, subscriptions, units, users, type Club } from '../db/schema.js';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../lib/errors.js';
import { parse, Uuid } from '../lib/validate.js';
import { can, isOwner, LEADER_ROLES } from '../permissions.js';
import { resolveTheme } from '../theme.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newJoinCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

export const slugify = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'clube';

const ClubName = z.string().trim().min(2).max(80);
const OptText = z.string().trim().max(120).nullable().optional();
const Settings = z.object({
  autoApproveDesbravadores: z.boolean().optional(),
  counselorScope: z.enum(['club', 'unit']).optional(),
}).strict();
const CreateClub = z.object({ name: ClubName, church: OptText, region: OptText });
const UpdateClub = z.object({ name: ClubName.optional(), church: OptText, region: OptText, settings: Settings.optional() });
const DeleteClub = z.object({ confirm: z.string() });
const Join = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6,12}$/, 'Código inválido.'),
  role: z.enum(['desbravador', 'conselheiro', 'instrutor', 'associado']).default('desbravador'),
  unitId: Uuid.nullable().optional(),
});
const Transfer = z.object({ memberId: Uuid });
const UnitBody = z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() });

/** Endereço do logo com a versão no fim, para o navegador trocar a imagem quando ela mudar. */
export async function logoUrl(db: FastifyInstance['db'], clubId: string) {
  const [l] = await db.select({ sha: clubLogos.sha256 }).from(clubLogos).where(eq(clubLogos.clubId, clubId)).limit(1);
  return l ? `/api/clubs/${clubId}/logo?v=${l.sha.slice(0, 12)}` : null;
}

/** Dados de marca que qualquer pessoa pode ver (usados também na tela de login do clube). */
export async function branding(db: FastifyInstance['db'], club: Club) {
  return { theme: resolveTheme(club.theme), customTheme: club.theme, logoUrl: await logoUrl(db, club.id) };
}

export async function clubRoutes(app: FastifyInstance) {
  const { db, config } = app;

  /** Qualquer pessoa cadastrada pode criar clubes; quem cria é o administrador e ganha o período de teste. */
  app.post('/clubs', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(CreateClub, req.body);
    const base = slugify(body.name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomInt(1000, 9999)}`;
      try {
        const out = await db.transaction(async (tx) => {
          const [club] = await tx.insert(clubs).values({
            name: body.name, church: body.church ?? null, region: body.region ?? null,
            slug, joinCode: newJoinCode(), ownerId: user.id, createdBy: user.id,
          }).returning();
          const [m] = await tx.insert(memberships).values({
            clubId: club.id, userId: user.id, role: 'diretor', status: 'ativo', approvedAt: new Date(),
          }).returning();
          const [sub] = await tx.insert(subscriptions).values({
            clubId: club.id, status: 'trial', trialEndsAt: new Date(Date.now() + config.trialDays * 864e5),
          }).returning();
          await audit(tx, { clubId: club.id, actorId: user.id, action: 'club.create', targetId: club.id });
          return { club, membership: m, subscription: { ...sub, ...subscriptionState(sub) } };
        });
        return reply.status(201).send(out);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    throw conflict('Não foi possível gerar um endereço para o clube. Tente outro nome.');
  });

  app.get('/clubs/:clubId', async (req) => {
    const ctx = await clubCtx(req, (req.params as { clubId: string }).clubId);
    const us = await db.select().from(units).where(eq(units.clubId, ctx.club.id)).orderBy(units.name);
    const [owner] = await db.select({ id: users.id, name: users.name, username: users.username }).from(users).where(eq(users.id, ctx.club.ownerId));
    const sub = await getSubscription(db, ctx.club.id);
    const { joinCode, theme, ...club } = ctx.club;
    return {
      club: { ...club, joinCode: can(ctx, 'club.joinCode') ? joinCode : undefined },
      admin: owner,
      isAdmin: isOwner(ctx),
      subscription: subscriptionState(sub),
      branding: await branding(db, ctx.club),
      units: us,
      membership: ctx.membership,
    };
  });

  app.patch('/clubs/:clubId', async (req) => {
    const ctx = await clubCtx(req, (req.params as { clubId: string }).clubId, 'club.update');
    const body = parse(UpdateClub, req.body);
    const settings = body.settings ? { ...DEFAULT_CLUB_SETTINGS, ...ctx.club.settings, ...body.settings } : undefined;
    const [club] = await db.update(clubs).set({
      name: body.name, church: body.church, region: body.region, settings, updatedAt: new Date(),
    }).where(eq(clubs.id, ctx.club.id)).returning();
    await audit(db, { clubId: club.id, actorId: ctx.user.id, action: 'club.update', data: body });
    return { club };
  });

  app.delete('/clubs/:clubId', async (req, reply) => {
    const ctx = await clubCtx(req, (req.params as { clubId: string }).clubId, 'club.delete', { allowInactive: true });
    const body = parse(DeleteClub, req.body);
    if (body.confirm !== ctx.club.name) throw badRequest('Digite o nome exato do clube para confirmar.');
    await db.delete(clubs).where(eq(clubs.id, ctx.club.id));
    await audit(db, { actorId: ctx.user.id, action: 'club.delete', targetId: ctx.club.id, data: { name: ctx.club.name } });
    return reply.status(204).send();
  });

  /** Passa a administração do clube para outro membro ativo da liderança. */
  app.post('/clubs/:clubId/transfer', async (req) => {
    const ctx = await clubCtx(req, (req.params as { clubId: string }).clubId, 'club.transfer', { allowInactive: true });
    const { memberId } = parse(Transfer, req.body);
    const { m, u } = await loadMember(db, ctx.club.id, memberId);
    if (u.id === ctx.club.ownerId) throw badRequest('Essa pessoa já é a administradora do clube.');
    if (m.status !== 'ativo') throw badRequest('Só um membro ativo pode receber a administração.');
    if (!LEADER_ROLES.includes(m.role)) throw badRequest('A administração só pode ir para alguém da liderança.');
    const [club] = await db.update(clubs).set({ ownerId: u.id, updatedAt: new Date() }).where(eq(clubs.id, ctx.club.id)).returning();
    await audit(db, { clubId: club.id, actorId: ctx.user.id, action: 'club.transfer', targetId: m.id, data: { from: ctx.club.ownerId, to: u.id } });
    return { admin: { id: u.id, name: u.name, username: u.username } };
  });

  app.post('/clubs/:clubId/join-code', async (req) => {
    const ctx = await clubCtx(req, (req.params as { clubId: string }).clubId, 'club.joinCode');
    const [club] = await db.update(clubs).set({ joinCode: newJoinCode(), updatedAt: new Date() })
      .where(eq(clubs.id, ctx.club.id)).returning({ joinCode: clubs.joinCode });
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'club.joinCode.rotate' });
    return club;
  });

  /** Entrar num clube com o código de convite. Liderança sempre fica pendente até a diretoria aprovar. */
  app.post('/clubs/join', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(Join, req.body);
    const [club] = await db.select().from(clubs).where(eq(clubs.joinCode, body.code)).limit(1);
    if (!club) throw notFound('Código de clube não encontrado.');
    await assertActive(db, club.id);
    await assertMemberRoom(db, club.id);
    await assertUnit(db, club.id, body.unitId);
    const kid = body.role === 'desbravador';
    const settings = { ...DEFAULT_CLUB_SETTINGS, ...club.settings };
    const status = kid && settings.autoApproveDesbravadores ? 'ativo' : 'pendente';
    try {
      const [m] = await db.insert(memberships).values({
        clubId: club.id, userId: user.id, role: body.role, status, unitId: body.unitId ?? null,
        classId: kid ? classForAge(ageOf(user.birth)) : null,
        approvedAt: status === 'ativo' ? new Date() : null,
      }).returning();
      await audit(db, { clubId: club.id, actorId: user.id, action: 'member.join', targetId: m.id, data: { role: m.role, status } });
      return reply.status(201).send({ membership: m, club: { id: club.id, name: club.name, slug: club.slug } });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Você já faz parte deste clube.');
      throw e;
    }
  });

  app.post('/clubs/:clubId/leave', async (req, reply) => {
    const user = requireUser(req);
    const clubId = parse(Uuid, (req.params as { clubId: string }).clubId);
    const [row] = await db.select({ m: memberships, ownerId: clubs.ownerId }).from(memberships)
      .innerJoin(clubs, eq(clubs.id, memberships.clubId))
      .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, user.id))).limit(1);
    if (!row) throw notFound('Você não faz parte deste clube.');
    if (row.ownerId === user.id) throw forbidden('Você é o administrador. Passe a administração para outra pessoa antes de sair.');
    await db.delete(memberships).where(eq(memberships.id, row.m.id));
    await audit(db, { clubId, actorId: user.id, action: 'member.leave', targetId: row.m.id });
    return reply.status(204).send();
  });

  /* ---------- unidades ---------- */

  app.get('/clubs/:clubId/units', async (req) => {
    const ctx = await clubCtx(req, (req.params as { clubId: string }).clubId);
    return { units: await db.select().from(units).where(eq(units.clubId, ctx.club.id)).orderBy(units.name) };
  });

  app.post('/clubs/:clubId/units', async (req, reply) => {
    const ctx = await clubCtx(req, (req.params as { clubId: string }).clubId, 'units.manage');
    const body = parse(UnitBody, req.body);
    try {
      const [u] = await db.insert(units).values({ clubId: ctx.club.id, name: body.name, color: body.color ?? null }).returning();
      await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'unit.create', targetId: u.id, data: body });
      return reply.status(201).send({ unit: u });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Já existe uma unidade com esse nome.');
      throw e;
    }
  });

  app.patch('/clubs/:clubId/units/:unitId', async (req) => {
    const p = req.params as { clubId: string; unitId: string };
    const ctx = await clubCtx(req, p.clubId, 'units.manage');
    const body = parse(UnitBody.partial(), req.body);
    try {
      const [u] = await db.update(units).set(body)
        .where(and(eq(units.id, parse(Uuid, p.unitId)), eq(units.clubId, ctx.club.id))).returning();
      if (!u) throw notFound('Unidade não encontrada.');
      await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'unit.update', targetId: u.id, data: body });
      return { unit: u };
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Já existe uma unidade com esse nome.');
      throw e;
    }
  });

  app.delete('/clubs/:clubId/units/:unitId', async (req, reply) => {
    const p = req.params as { clubId: string; unitId: string };
    const ctx = await clubCtx(req, p.clubId, 'units.manage');
    const [u] = await db.delete(units)
      .where(and(eq(units.id, parse(Uuid, p.unitId)), eq(units.clubId, ctx.club.id))).returning();
    if (!u) throw notFound('Unidade não encontrada.');
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'unit.delete', targetId: u.id, data: { name: u.name } });
    return reply.status(204).send();
  });
}
