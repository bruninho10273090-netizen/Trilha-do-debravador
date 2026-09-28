import { like, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import { hashPassword, LEGACY_PREFIX } from '../auth/password.js';
import { ageOf, CLASS_IDS, classForAge, isCustomSpecialty, ITEMS, SPECIALTIES } from '../catalog/index.js';
import { audit, requireUser } from '../context.js';
import {
  clubs, memberships, requirementProgress, specialtyProgress, subscriptions, units, users, type Role,
} from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { ROLES } from '../permissions.js';
import { newJoinCode, slugify } from './clubs.js';

/* Formato do arquivo que o app antigo (artefato ou modo local) exporta. Leitura tolerante:
   o que não for reconhecido é ignorado, nunca derruba a importação. */
const Idx = z.number().int().min(0).max(50);
const Entry = z.object({
  s: z.enum(['enviado', 'aprovado', 'devolvido']).nullable().optional().catch(null),
  at: z.number().optional().catch(undefined),
  by: z.string().nullable().optional().catch(null),
  cm: z.string().max(2000).nullable().optional().catch(null),
  choice: z.array(Idx).max(10).optional().catch(undefined),
  subs: z.array(Idx).max(50).optional().catch(undefined),
});
const Esp = z.object({
  s: z.enum(['andamento', 'enviado', 'aprovado', 'devolvido']).nullable().optional().catch(null),
  at: z.number().optional().catch(undefined),
  by: z.string().nullable().optional().catch(null),
  cm: z.string().max(2000).nullable().optional().catch(null),
  name: z.string().max(80).optional().catch(undefined),
  area: z.string().max(4).optional().catch(undefined),
});
const Member = z.object({
  id: z.string().min(1).max(64),
  username: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  role: z.enum(ROLES as [Role, ...Role[]]),
  unit: z.string().nullable().optional(),
  birth: z.string().nullable().optional(),
  classId: z.string().nullable().optional(),
  status: z.string().optional(),
  salt: z.string().max(200).optional(),
  hash: z.string().max(200).optional(),
  progress: z.record(z.string(), Entry.nullable().catch(null)).optional(),
  esp: z.record(z.string(), Esp.nullable().catch(null)).optional(),
});
export const ExportFile = z.object({
  format: z.literal('trilha-export'),
  version: z.literal(1),
  config: z.object({
    name: z.string().trim().min(2).max(80),
    units: z.array(z.object({ id: z.string().max(64), name: z.string().trim().min(1).max(40), color: z.string().nullable().optional() })).max(50).optional(),
  }),
  members: z.record(z.string(), Member).refine((m) => Object.keys(m).length <= 1000, 'No máximo 1000 membros.'),
  notes: z.record(z.string(), z.object({ t: z.record(z.string(), z.string().max(10000)).optional() })).optional(),
  answers: z.record(z.string(), z.object({ a: z.record(z.string(), z.string().max(10000)).optional(), d: z.array(Idx).max(50).optional() })).optional(),
});
const Body = z.object({ data: ExportFile, me: z.string().max(64).nullable().optional() });

const toDate = (ms?: number) => (ms && ms > 0 && ms < 4102444800000 ? new Date(ms) : null);
const validBirth = (b?: string | null) => (b && /^\d{4}-\d{2}-\d{2}$/.test(b) && !Number.isNaN(Date.parse(b)) ? b : null);
const cleanUser = (u: string) => {
  const c = u.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9._-]/g, '').replace(/^\.+$/, '').slice(0, 24);
  return c.length >= 3 ? c : (c + 'dbv').slice(0, 24);
};
/** Especialidade livre do app antigo (x-nome-abc123) vira custom-nome-abc123. */
const espId = (id: string) => {
  if (SPECIALTIES.has(id)) return id;
  const base = id.replace(/^(x-|custom-)/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const c = 'custom-' + (base || randomBytes(3).toString('hex'));
  return isCustomSpecialty(c) ? c : null;
};

export async function importRoutes(app: FastifyInstance) {
  const { db, config } = app;

  /**
   * Recria no servidor um clube exportado do app antigo: unidades, membros (com as
   * mesmas senhas), cartões, respostas e caderno de especialidades. Quem importa vira
   * o administrador do clube novo.
   */
  app.post('/clubs/import', {
    bodyLimit: 25 * 1024 * 1024,
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const user = requireUser(req);
    const { data, me } = parse(Body, req.body);
    const list = Object.values(data.members);
    if (me && !data.members[me]) throw badRequest('A pessoa escolhida não está no arquivo.');

    // nomes de usuário: os que já existem no servidor ganham um final diferente
    const wanted = list.filter((m) => m.id !== me).map((m) => ({ m, base: cleanUser(m.username) }));
    const exists = async (u: string) => (await db.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${u}`).limit(1)).length > 0;
    const taken = new Set<string>();
    const chosen = new Map<string, string>();
    const renamed: { name: string; from: string; to: string }[] = [];
    for (const { m, base } of wanted) {
      let u = base, n = 2;
      while (taken.has(u) || (await exists(u))) u = base.slice(0, 24 - String(n).length - 1) + '-' + n++;
      taken.add(u); chosen.set(m.id, u);
      if (u !== m.username.toLowerCase()) renamed.push({ name: m.name, from: m.username, to: u });
    }

    // endereço do clube livre
    const base = slugify(data.config.name);
    const used = new Set((await db.select({ s: clubs.slug }).from(clubs).where(like(clubs.slug, base + '%'))).map((r) => r.s));
    let slug = base;
    while (used.has(slug)) slug = `${base}-${randomInt(1000, 9999)}`;

    const withoutPassword: { name: string; username: string }[] = [];
    const pwHash = new Map<string, string>();
    for (const m of list) {
      if (m.id === me) continue;
      if (m.hash?.startsWith('p2:') && m.salt && !m.salt.includes('$')) pwHash.set(m.id, LEGACY_PREFIX + m.salt + '$' + m.hash.slice(3));
      else {
        pwHash.set(m.id, await hashPassword(randomBytes(18).toString('base64url')));
        withoutPassword.push({ name: m.name, username: chosen.get(m.id)! });
      }
    }

    const out = await db.transaction(async (tx) => {
      const [club] = await tx.insert(clubs).values({
        name: data.config.name, slug, joinCode: newJoinCode(), ownerId: user.id, createdBy: user.id,
      }).returning();
      await tx.insert(subscriptions).values({ clubId: club.id, status: 'trial', trialEndsAt: new Date(Date.now() + config.trialDays * 864e5) });

      const unitId = new Map<string, string>();
      const seenUnit = new Set<string>();
      for (const u of data.config.units ?? []) {
        if (seenUnit.has(u.name.toLowerCase())) continue;
        seenUnit.add(u.name.toLowerCase());
        const [row] = await tx.insert(units).values({ clubId: club.id, name: u.name, color: /^#[0-9a-fA-F]{6}$/.test(u.color ?? '') ? u.color! : null }).returning();
        unitId.set(u.id, row.id);
      }

      // contas e vínculos; "me" é quem está importando
      const userOf = new Map<string, string>();
      const memberOf = new Map<string, string>();
      for (const m of list) {
        let uid = user.id;
        if (m.id !== me) {
          const [row] = await tx.insert(users).values({
            username: chosen.get(m.id)!, name: m.name.trim().slice(0, 80).padEnd(2, '.'),
            birth: validBirth(m.birth), passwordHash: pwHash.get(m.id)!,
          }).returning({ id: users.id });
          uid = row.id;
        }
        userOf.set(m.id, uid);
        const birth = m.id === me ? user.birth : validBirth(m.birth);
        const kid = m.role === 'desbravador';
        const [ms] = await tx.insert(memberships).values({
          clubId: club.id, userId: uid, role: m.role,
          status: m.id === me ? 'ativo' : m.status === 'pendente' ? 'pendente' : 'ativo',
          unitId: (m.unit && unitId.get(m.unit)) || null,
          classId: kid ? (CLASS_IDS.includes(m.classId ?? '') ? m.classId! : classForAge(ageOf(birth))) : null,
          approvedAt: new Date(),
        }).returning({ id: memberships.id });
        memberOf.set(m.id, ms.id);
      }
      if (!me) {
        await tx.insert(memberships).values({ clubId: club.id, userId: user.id, role: 'diretor', status: 'ativo', approvedAt: new Date() });
      }

      // cartões de classe e caderno
      const reqRows: (typeof requirementProgress.$inferInsert)[] = [];
      const espRows: (typeof specialtyProgress.$inferInsert)[] = [];
      for (const m of list) {
        const mid = memberOf.get(m.id)!;
        const notes = data.notes?.[m.id]?.t ?? {};
        const keys = new Set([...Object.keys(m.progress ?? {}), ...Object.keys(notes)]);
        for (const key of keys) {
          const it = ITEMS.get(key);
          if (!it) continue;
          const e = m.progress?.[key] ?? null;
          const note = typeof notes[key] === 'string' && notes[key].trim() ? notes[key] : null;
          const choice = it.o && e?.choice ? [...new Set(e.choice.filter((i) => i < it.o!.length))].slice(0, it.k ?? 1) : null;
          const subs = it.a && e?.subs ? [...new Set(e.subs.filter((i) => i < it.a!.length))].sort((a, b) => a - b) : null;
          if (!e?.s && !note && !choice?.length && !subs?.length) continue;
          const at = toDate(e?.at);
          reqRows.push({
            membershipId: mid, itemKey: key, status: e?.s ?? null, note, choice: choice?.length ? choice : null, subs: subs?.length ? subs : null,
            comment: e?.s === 'devolvido' ? e.cm ?? null : null,
            submittedAt: e?.s === 'enviado' ? at : null,
            reviewedAt: e?.s === 'aprovado' || e?.s === 'devolvido' ? at : null,
            reviewedBy: (e?.s === 'aprovado' || e?.s === 'devolvido') && e.by ? userOf.get(e.by) ?? null : null,
            updatedBy: userOf.get(m.id)!, updatedAt: at ?? new Date(),
          });
        }
        const espKeys = new Set([...Object.keys(m.esp ?? {}), ...Object.keys(data.answers ?? {}).filter((k) => k.startsWith(m.id + '~')).map((k) => k.slice(m.id.length + 1))]);
        const seenEsp = new Set<string>();
        for (const old of espKeys) {
          const id = espId(old);
          if (!id || seenEsp.has(id)) continue;
          seenEsp.add(id);
          const v = m.esp?.[old] ?? null;
          const ans = data.answers?.[m.id + '~' + old];
          const spec = SPECIALTIES.get(id);
          const nReqs = spec ? spec.reqs.length : 1;
          const answers = Object.fromEntries(Object.entries(ans?.a ?? {}).filter(([k, t]) => /^r\d{1,2}$/.test(k) && Number(k.slice(1)) < nReqs && typeof t === 'string'));
          const done = spec ? [...new Set((ans?.d ?? []).filter((i) => i < nReqs))].sort((a, b) => a - b) : [];
          if (!v?.s && !Object.keys(answers).length && !done.length) continue;
          const at = toDate(v?.at);
          espRows.push({
            membershipId: mid, specialtyId: id, status: v?.s ?? null,
            customName: spec ? null : (v?.name?.trim() || 'Especialidade livre'), customArea: spec ? null : (v?.area ?? 'AR'),
            answers, done, comment: v?.s === 'devolvido' ? v.cm ?? null : null,
            submittedAt: v?.s === 'enviado' ? at : null,
            reviewedAt: v?.s === 'aprovado' || v?.s === 'devolvido' ? at : null,
            reviewedBy: (v?.s === 'aprovado' || v?.s === 'devolvido') && v.by ? userOf.get(v.by) ?? null : null,
            updatedAt: at ?? new Date(),
          });
        }
      }
      for (let i = 0; i < reqRows.length; i += 500) await tx.insert(requirementProgress).values(reqRows.slice(i, i + 500));
      for (let i = 0; i < espRows.length; i += 500) await tx.insert(specialtyProgress).values(espRows.slice(i, i + 500));

      await audit(tx, { clubId: club.id, actorId: user.id, action: 'club.import', targetId: club.id, data: { members: list.length, requirements: reqRows.length, specialties: espRows.length } });
      return { club: { id: club.id, name: club.name, slug: club.slug }, requirements: reqRows.length, specialties: espRows.length };
    });

    return reply.status(201).send({ ...out, members: list.length, renamed, withoutPassword });
  });
}
