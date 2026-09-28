import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { audit, clubCtx } from '../context.js';
import { clubLogos, clubs } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse, Uuid } from '../lib/validate.js';
import { contrastWarnings, resolveTheme, ThemePatch, themeCss, THEME_KEYS, type ClubTheme } from '../theme.js';
import { branding } from './clubs.js';

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Confere pelos primeiros bytes que o arquivo é mesmo a imagem que diz ser. */
function sniff(buf: Buffer): string | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

type P = { clubId: string; slug: string };

export async function brandingRoutes(app: FastifyInstance) {
  const { db } = app;

  /** Lista das cores que dá para personalizar, com o padrão de cada uma (para montar a tela de ajustes). */
  app.get('/theme/keys', async () => ({
    keys: Object.entries(THEME_KEYS).map(([key, v]) => ({ key, label: v.label, cssVar: v.css, default: v.def })),
  }));

  /** Nome, cores e logo de um clube pelo endereço, sem login (para a tela de entrada do clube). */
  app.get('/public/clubs/:slug', async (req) => {
    const slug = String((req.params as P).slug).toLowerCase();
    const [club] = await db.select().from(clubs).where(eq(clubs.slug, slug)).limit(1);
    if (!club) throw notFound('Clube não encontrado.');
    return { club: { id: club.id, name: club.name, slug: club.slug }, branding: await branding(db, club) };
  });

  app.get('/clubs/:clubId/theme.css', async (req, reply) => {
    const id = parse(Uuid, (req.params as P).clubId);
    const [club] = await db.select({ theme: clubs.theme }).from(clubs).where(eq(clubs.id, id)).limit(1);
    if (!club) throw notFound('Clube não encontrado.');
    reply.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'public, max-age=300');
    return themeCss(club.theme);
  });

  /** Ajusta as cores; mandar null numa cor volta ela para o padrão. Avisa se algum texto ficar ilegível. */
  app.patch('/clubs/:clubId/theme', async (req) => {
    const ctx = await clubCtx(req, (req.params as P).clubId, 'club.branding');
    const body = parse(ThemePatch, req.body);
    const next: Partial<ClubTheme> = { ...ctx.club.theme };
    for (const [k, v] of Object.entries(body) as [keyof ClubTheme, string | null | undefined][]) {
      if (v === null) delete next[k];
      else if (v !== undefined) next[k] = v;
    }
    await db.update(clubs).set({ theme: next, updatedAt: new Date() }).where(eq(clubs.id, ctx.club.id));
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'club.theme.update', data: body });
    const theme = resolveTheme(next);
    return { theme, customTheme: next, warnings: contrastWarnings(theme) };
  });

  app.delete('/clubs/:clubId/theme', async (req) => {
    const ctx = await clubCtx(req, (req.params as P).clubId, 'club.branding');
    await db.update(clubs).set({ theme: {}, updatedAt: new Date() }).where(eq(clubs.id, ctx.club.id));
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'club.theme.reset' });
    return { theme: resolveTheme({}), customTheme: {}, warnings: [] };
  });

  /** Envia o logo: o corpo da requisição é o próprio arquivo (Content-Type: image/png, image/jpeg ou image/webp). */
  app.put('/clubs/:clubId/logo', async (req) => {
    const ctx = await clubCtx(req, (req.params as P).clubId, 'club.branding');
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw badRequest('Envie a imagem do logo no corpo da requisição.');
    const type = sniff(buf);
    if (!type || type !== req.headers['content-type']?.split(';')[0].trim()) {
      throw badRequest('O arquivo precisa ser uma imagem PNG, JPEG ou WebP.');
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const row = { contentType: type, data: buf, size: buf.length, sha256, updatedAt: new Date() };
    await db.insert(clubLogos).values({ clubId: ctx.club.id, ...row })
      .onConflictDoUpdate({ target: clubLogos.clubId, set: row });
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'club.logo.update', data: { type, size: buf.length } });
    return { logoUrl: `/api/clubs/${ctx.club.id}/logo?v=${sha256.slice(0, 12)}`, size: buf.length, contentType: type };
  });

  app.get('/clubs/:clubId/logo', async (req, reply) => {
    const id = parse(Uuid, (req.params as P).clubId);
    const [logo] = await db.select().from(clubLogos).where(eq(clubLogos.clubId, id)).limit(1);
    if (!logo) throw notFound('Este clube não tem logo.');
    const etag = `"${logo.sha256}"`;
    reply.header('etag', etag)
      .header('cache-control', 'public, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'");
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.type(logo.contentType).send(logo.data);
  });

  app.delete('/clubs/:clubId/logo', async (req, reply) => {
    const ctx = await clubCtx(req, (req.params as P).clubId, 'club.branding');
    await db.delete(clubLogos).where(eq(clubLogos.clubId, ctx.club.id));
    await audit(db, { clubId: ctx.club.id, actorId: ctx.user.id, action: 'club.logo.delete' });
    return reply.status(204).send();
  });
}
