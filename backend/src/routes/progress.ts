import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { catalog, computeStats, ESP_REFS, isCustomSpecialty, ITEMS, SPECIALTIES, type CatalogItem } from '../catalog/index.js';
import { audit, clubCtx, loadMember } from '../context.js';
import type { Tx } from '../db/index.js';
import { memberships, requirementProgress, specialtyProgress, users } from '../db/schema.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse, Uuid } from '../lib/validate.js';
import { can, canEditCard, canEditNotebook, canReview, type ClubCtx } from '../permissions.js';

type P = { clubId: string; memberId: string; key: string; espId: string };

const Note = z.string().max(10000);
const Idx = z.number().int().min(0).max(50);
const ReqPatch = z.object({ note: Note.nullable().optional(), choice: z.array(Idx).max(10).optional(), subs: z.array(Idx).max(50).optional() }).strict();
const ReturnBody = z.object({ comment: z.string().trim().min(1, 'Explique o que precisa melhorar.').max(1000) });
const BatchApprove = z.object({ keys: z.array(z.string()).min(1).max(100) });
const EspPatch = z.object({
  answers: z.record(z.string().regex(/^r\d{1,2}$/), Note).optional(),
  done: z.array(Idx).max(50).optional(),
  customName: z.string().trim().min(2).max(80).optional(),
  customArea: z.enum(Object.keys(catalog.areas) as [string, ...string[]]).optional(),
}).strict();

function item(key: string): CatalogItem {
  const it = ITEMS.get(key);
  if (!it) throw notFound('Requisito não existe no cartão.');
  return it;
}

function checkEsp(id: string) {
  if (!SPECIALTIES.has(id) && !isCustomSpecialty(id)) throw notFound('Especialidade não existe no caderno.');
}

/** O cartão pertence a um desbravador ativo do clube. */
async function cardOwner(req: FastifyRequest, perm?: 'view') {
  const p = req.params as P;
  const ctx = await clubCtx(req, p.clubId);
  const { m, u } = await loadMember(req.server.db, ctx.club.id, p.memberId);
  if (m.role !== 'desbravador') throw badRequest('Só desbravadores têm cartão de classe.');
  if (perm === 'view' && ctx.membership?.id !== m.id && !can(ctx, 'members.viewAll')) throw forbidden();
  return { ctx, m, u };
}

async function getReq(db: Tx, membershipId: string, key: string) {
  const [r] = await db.select().from(requirementProgress)
    .where(and(eq(requirementProgress.membershipId, membershipId), eq(requirementProgress.itemKey, key))).limit(1);
  return r ?? null;
}

async function upsertReq(db: Tx, membershipId: string, key: string, set: Partial<typeof requirementProgress.$inferInsert>, actorId: string) {
  const values = { ...set, updatedBy: actorId, updatedAt: new Date() };
  const [r] = await db.insert(requirementProgress).values({ membershipId, itemKey: key, ...values })
    .onConflictDoUpdate({ target: [requirementProgress.membershipId, requirementProgress.itemKey], set: values }).returning();
  return r;
}

async function getEsp(db: Tx, membershipId: string, id: string) {
  const [r] = await db.select().from(specialtyProgress)
    .where(and(eq(specialtyProgress.membershipId, membershipId), eq(specialtyProgress.specialtyId, id))).limit(1);
  return r ?? null;
}

async function upsertEsp(db: Tx, membershipId: string, id: string, set: Partial<typeof specialtyProgress.$inferInsert>) {
  const values = { ...set, updatedAt: new Date() };
  const [r] = await db.insert(specialtyProgress).values({ membershipId, specialtyId: id, ...values })
    .onConflictDoUpdate({ target: [specialtyProgress.membershipId, specialtyProgress.specialtyId], set: values }).returning();
  return r;
}

function validChoice(it: CatalogItem, choice: number[] | null | undefined) {
  if (!it.o) return true;
  const k = it.k ?? 1;
  return Array.isArray(choice) && new Set(choice).size >= k;
}

/** Aprova requisitos (e registra quem aprovou). Usado na aprovação direta, em lote e pela especialidade. */
async function approveReqs(tx: Tx, ctx: ClubCtx, m: { id: string }, keys: string[], choices: Record<string, number[]> = {}) {
  const out = [];
  for (const key of keys) {
    out.push(await upsertReq(tx, m.id, key, {
      status: 'aprovado', comment: null, reviewedBy: ctx.user.id, reviewedAt: new Date(),
      ...(choices[key] ? { choice: choices[key] } : {}),
    }, ctx.user.id));
  }
  return out;
}

export async function progressRoutes(app: FastifyInstance) {
  const { db } = app;
  const base = '/clubs/:clubId/members/:memberId';

  app.get(`${base}/progress`, async (req) => {
    const { m } = await cardOwner(req, 'view');
    const reqs = await db.select().from(requirementProgress).where(eq(requirementProgress.membershipId, m.id));
    const esps = await db.select().from(specialtyProgress).where(eq(specialtyProgress.membershipId, m.id));
    return { requirements: reqs, specialties: esps, stats: computeStats(reqs, esps) };
  });

  /**
   * Progresso de todos os desbravadores ativos do clube numa chamada só (ranking,
   * aprovações, painel). O status é visível a todos; respostas escritas, opções e
   * comentários só para a liderança e para o próprio desbravador.
   */
  app.get('/clubs/:clubId/progress', async (req) => {
    const ctx = await clubCtx(req, (req.params as P).clubId);
    const kids = await db.select({ id: memberships.id }).from(memberships).where(and(
      eq(memberships.clubId, ctx.club.id), eq(memberships.role, 'desbravador'), eq(memberships.status, 'ativo')));
    const ids = kids.map((k) => k.id);
    if (!ids.length) return { requirements: [], specialties: [] };
    const full = can(ctx, 'members.viewAll');
    const mine = ctx.membership?.id;
    const reqs = await db.select().from(requirementProgress).where(inArray(requirementProgress.membershipId, ids));
    const esps = await db.select().from(specialtyProgress).where(inArray(specialtyProgress.membershipId, ids));
    const open = (id: string) => full || id === mine;
    return {
      requirements: reqs.map((r) => open(r.membershipId) ? r
        : { membershipId: r.membershipId, itemKey: r.itemKey, status: r.status, reviewedAt: r.reviewedAt, updatedAt: r.updatedAt }),
      specialties: esps.filter((s) => s.status).map((s) => open(s.membershipId) ? s
        : { membershipId: s.membershipId, specialtyId: s.specialtyId, status: s.status, customName: s.customName, customArea: s.customArea, reviewedAt: s.reviewedAt, updatedAt: s.updatedAt }),
    };
  });

  /* ---------- requisitos de classe ---------- */

  app.patch(`${base}/requirements/:key`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const it = item((req.params as P).key);
    if (!canEditCard(ctx, m)) throw forbidden();
    const body = parse(ReqPatch, req.body);
    const cur = await getReq(db, m.id, it.key);
    if (cur?.status === 'aprovado') throw badRequest('Esse requisito já foi aprovado.');
    const self = ctx.membership?.id === m.id;
    if (cur?.status === 'enviado' && self) throw badRequest('Cancele o envio para editar.');
    if (body.choice) {
      if (!it.o) throw badRequest('Esse requisito não tem opções.');
      if (body.choice.some((i) => i >= it.o!.length) || body.choice.length > (it.k ?? 1)) throw badRequest(`Escolha até ${it.k ?? 1} opção(ões) válidas.`);
    }
    if (body.subs) {
      if (!it.a) throw badRequest('Esse requisito não tem subitens.');
      if (body.subs.some((i) => i >= it.a!.length)) throw badRequest('Subitem inválido.');
    }
    const r = await upsertReq(db, m.id, it.key, {
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.choice ? { choice: [...new Set(body.choice)] } : {}),
      ...(body.subs ? { subs: [...new Set(body.subs)].sort((a, b) => a - b) } : {}),
    }, ctx.user.id);
    return { requirement: r };
  });

  app.post(`${base}/requirements/:key/submit`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const it = item((req.params as P).key);
    if (!canEditCard(ctx, m)) throw forbidden();
    const cur = await getReq(db, m.id, it.key);
    if (cur?.status === 'enviado' || cur?.status === 'aprovado') throw badRequest('Esse requisito já foi enviado.');
    if (!validChoice(it, cur?.choice)) throw badRequest(`Escolha ${(it.k ?? 1) > 1 ? `as ${it.k} opções` : 'uma opção'} antes de enviar.`);
    const r = await upsertReq(db, m.id, it.key, { status: 'enviado', comment: null, submittedAt: new Date() }, ctx.user.id);
    return { requirement: r };
  });

  app.post(`${base}/requirements/:key/unsubmit`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const it = item((req.params as P).key);
    if (!canEditCard(ctx, m)) throw forbidden();
    const cur = await getReq(db, m.id, it.key);
    if (cur?.status !== 'enviado') throw badRequest('Esse requisito não está aguardando aprovação.');
    return { requirement: await upsertReq(db, m.id, it.key, { status: null, submittedAt: null }, ctx.user.id) };
  });

  app.post(`${base}/requirements/:key/approve`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const it = item((req.params as P).key);
    if (!canReview(ctx, m)) throw forbidden();
    const [r] = await db.transaction(async (tx) => {
      const out = await approveReqs(tx, ctx, m, [it.key]);
      await audit(tx, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'requirement.approve', targetId: m.id, data: { key: it.key } });
      return out;
    });
    return { requirement: r };
  });

  /** Aprova vários de uma vez (ex.: uma seção inteira). */
  app.post(`${base}/requirements/approve`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    if (!canReview(ctx, m)) throw forbidden();
    const keys = [...new Set(parse(BatchApprove, req.body).keys)];
    keys.forEach(item);
    const out = await db.transaction(async (tx) => {
      const rs = await approveReqs(tx, ctx, m, keys);
      await audit(tx, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'requirement.approve', targetId: m.id, data: { keys } });
      return rs;
    });
    return { requirements: out };
  });

  app.post(`${base}/requirements/:key/return`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const it = item((req.params as P).key);
    if (!canReview(ctx, m)) throw forbidden();
    const { comment } = parse(ReturnBody, req.body);
    const cur = await getReq(db, m.id, it.key);
    if (cur?.status !== 'enviado') throw badRequest('Só dá para devolver o que foi enviado.');
    const r = await upsertReq(db, m.id, it.key, { status: 'devolvido', comment, reviewedBy: ctx.user.id, reviewedAt: new Date() }, ctx.user.id);
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'requirement.return', targetId: m.id, data: { key: it.key, comment } });
    return { requirement: r };
  });

  app.post(`${base}/requirements/:key/unapprove`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const it = item((req.params as P).key);
    if (!canReview(ctx, m)) throw forbidden();
    const cur = await getReq(db, m.id, it.key);
    if (cur?.status !== 'aprovado') throw badRequest('Esse requisito não está aprovado.');
    const r = await upsertReq(db, m.id, it.key, { status: null, reviewedBy: ctx.user.id, reviewedAt: new Date() }, ctx.user.id);
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'requirement.unapprove', targetId: m.id, data: { key: it.key } });
    return { requirement: r };
  });

  /* ---------- caderno de especialidades ---------- */

  app.patch(`${base}/specialties/:espId`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const id = (req.params as P).espId;
    checkEsp(id);
    if (!canEditNotebook(ctx, m)) throw forbidden('O caderno é pessoal: só o próprio desbravador escreve nele.');
    const body = parse(EspPatch, req.body);
    const cur = await getEsp(db, m.id, id);
    if (cur?.status === 'enviado' || cur?.status === 'aprovado') throw badRequest('Cancele o envio para editar.');
    const spec = SPECIALTIES.get(id);
    const nReqs = spec ? spec.reqs.length : 1;
    if (body.done && (!spec || body.done.some((i) => i >= nReqs))) throw badRequest('Requisito inválido.');
    if (body.answers && Object.keys(body.answers).some((k) => Number(k.slice(1)) >= nReqs)) throw badRequest('Resposta para requisito inexistente.');
    if (!spec && !cur && !body.customName) throw badRequest('Dê um nome para a especialidade.');
    if (spec && (body.customName || body.customArea)) throw badRequest('Só especialidades personalizadas têm nome próprio.');
    const r = await upsertEsp(db, m.id, id, {
      status: cur?.status ?? 'andamento',
      ...(body.answers ? { answers: { ...(cur?.answers ?? {}), ...body.answers } } : {}),
      ...(body.done ? { done: [...new Set(body.done)].sort((a, b) => a - b) } : {}),
      ...(body.customName ? { customName: body.customName } : {}),
      ...(body.customArea ? { customArea: body.customArea } : {}),
    });
    return { specialty: r };
  });

  app.post(`${base}/specialties/:espId/submit`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const id = (req.params as P).espId;
    checkEsp(id);
    if (!canEditNotebook(ctx, m)) throw forbidden();
    const cur = await getEsp(db, m.id, id);
    if (!cur || !(cur.status === 'andamento' || cur.status === 'devolvido')) throw badRequest('Essa especialidade não está em andamento.');
    const spec = SPECIALTIES.get(id);
    if (spec && cur.done.length < spec.reqs.length) throw badRequest('Marque todos os requisitos antes de enviar.');
    if (!spec && !cur.answers.r0?.trim()) throw badRequest('Escreva suas respostas antes de enviar.');
    const r = await upsertEsp(db, m.id, id, { status: 'enviado', comment: null, submittedAt: new Date() });
    return { specialty: r };
  });

  app.post(`${base}/specialties/:espId/unsubmit`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const id = (req.params as P).espId;
    checkEsp(id);
    if (!canEditNotebook(ctx, m)) throw forbidden();
    const cur = await getEsp(db, m.id, id);
    if (cur?.status !== 'enviado') throw badRequest('Essa especialidade não está aguardando aprovação.');
    return { specialty: await upsertEsp(db, m.id, id, { status: 'andamento', submittedAt: null }) };
  });

  /** Tira do caderno; as respostas continuam guardadas caso a pessoa volte a ela. */
  app.delete(`${base}/specialties/:espId`, async (req, reply) => {
    const { ctx, m } = await cardOwner(req);
    const id = (req.params as P).espId;
    checkEsp(id);
    if (!canEditNotebook(ctx, m)) throw forbidden();
    const cur = await getEsp(db, m.id, id);
    if (!cur?.status) throw notFound('Essa especialidade não está no caderno.');
    if (cur.status === 'enviado' || cur.status === 'aprovado') throw badRequest('Só dá para tirar especialidades em andamento ou devolvidas.');
    await upsertEsp(db, m.id, id, { status: null });
    return reply.status(204).send();
  });

  /** Aprovar a especialidade também cumpre os requisitos de classe que pedem por ela. */
  app.post(`${base}/specialties/:espId/approve`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const id = (req.params as P).espId;
    checkEsp(id);
    if (!canReview(ctx, m)) throw forbidden();
    const cur = await getEsp(db, m.id, id);
    if (!cur?.status) throw badRequest('Essa especialidade não está no caderno.');
    const spec = SPECIALTIES.get(id);
    const out = await db.transaction(async (tx) => {
      const s = await upsertEsp(tx, m.id, id, { status: 'aprovado', comment: null, reviewedBy: ctx.user.id, reviewedAt: new Date() });
      const refs = ESP_REFS.get(id) ?? [];
      const existing = refs.length ? await tx.select().from(requirementProgress)
        .where(and(eq(requirementProgress.membershipId, m.id), inArray(requirementProgress.itemKey, refs))) : [];
      const pending = refs.filter((k) => existing.find((e) => e.itemKey === k)?.status !== 'aprovado');
      const choices: Record<string, number[]> = {};
      for (const k of pending) {
        const it = ITEMS.get(k)!;
        const ix = spec && it.o ? it.o.findIndex((o) => catalog.espByName[normTxt(o)] === id) : -1;
        if (ix >= 0) choices[k] = [ix];
      }
      const linked = await approveReqs(tx, ctx, m, pending, choices);
      await audit(tx, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'specialty.approve', targetId: m.id, data: { id, linked: pending } });
      return { specialty: s, linkedRequirements: linked };
    });
    return out;
  });

  app.post(`${base}/specialties/:espId/return`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const id = (req.params as P).espId;
    checkEsp(id);
    if (!canReview(ctx, m)) throw forbidden();
    const { comment } = parse(ReturnBody, req.body);
    const cur = await getEsp(db, m.id, id);
    if (cur?.status !== 'enviado') throw badRequest('Só dá para devolver o que foi enviado.');
    const s = await upsertEsp(db, m.id, id, { status: 'devolvido', comment, reviewedBy: ctx.user.id, reviewedAt: new Date() });
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'specialty.return', targetId: m.id, data: { id, comment } });
    return { specialty: s };
  });

  app.post(`${base}/specialties/:espId/unapprove`, async (req) => {
    const { ctx, m } = await cardOwner(req);
    const id = (req.params as P).espId;
    checkEsp(id);
    if (!canReview(ctx, m)) throw forbidden();
    const cur = await getEsp(db, m.id, id);
    if (cur?.status !== 'aprovado') throw badRequest('Essa especialidade não está aprovada.');
    const s = await upsertEsp(db, m.id, id, { status: 'andamento', reviewedBy: ctx.user.id, reviewedAt: new Date() });
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'specialty.unapprove', targetId: m.id, data: { id } });
    return { specialty: s };
  });

  /* ---------- fila de aprovações da liderança ---------- */

  app.get('/clubs/:clubId/approvals', async (req) => {
    const ctx = await clubCtx(req, (req.params as P).clubId, 'progress.review');
    const q = parse(z.object({ unitId: Uuid.optional() }), req.query);
    const ms = await db.select({ m: memberships, name: users.name }).from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(
        eq(memberships.clubId, ctx.club.id), eq(memberships.role, 'desbravador'), eq(memberships.status, 'ativo'),
        q.unitId ? eq(memberships.unitId, q.unitId) : undefined,
      ));
    const visible = ms.filter(({ m }) => canReview(ctx, m));
    const ids = visible.map(({ m }) => m.id);
    if (!ids.length) return { requirements: [], specialties: [] };
    const who = new Map(visible.map(({ m, name }) => [m.id, { memberId: m.id, name, unitId: m.unitId }]));
    const reqs = await db.select().from(requirementProgress)
      .where(and(inArray(requirementProgress.membershipId, ids), eq(requirementProgress.status, 'enviado')))
      .orderBy(requirementProgress.submittedAt);
    const esps = await db.select().from(specialtyProgress)
      .where(and(inArray(specialtyProgress.membershipId, ids), eq(specialtyProgress.status, 'enviado')))
      .orderBy(specialtyProgress.submittedAt);
    return {
      requirements: reqs.map((r) => ({ ...r, member: who.get(r.membershipId) })),
      specialties: esps.map((s) => ({ ...s, member: who.get(s.membershipId) })),
    };
  });
}

// mesma normalização do front, para achar a opção do requisito pelo nome da especialidade
const DIACRITICS = /[̀-ͯ]/g;
function normTxt(s: string) {
  return String(s || '').toLowerCase().normalize('NFD').replace(DIACRITICS, '').replace(/[–—-]/g, ' ')
    .replace(/[^a-z0-9 .]/g, ' ').replace(/\s+/g, ' ').trim();
}
