import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { resolveSession } from './auth/session.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { User } from './db/schema.js';
import { HttpError } from './lib/errors.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { billingRoutes } from './routes/billing.js';
import { brandingRoutes, LOGO_TYPES } from './routes/branding.js';
import { catalogRoutes } from './routes/catalog.js';
import { clubRoutes } from './routes/clubs.js';
import { importRoutes } from './routes/import.js';
import { memberRoutes } from './routes/members.js';
import { progressRoutes } from './routes/progress.js';

declare module 'fastify' {
  interface FastifyInstance { db: Db; config: Config }
  interface FastifyRequest { auth: { user: User; sessionId: string } | null }
}

export async function buildApp(opts: { db: Db; config: Config; logger?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    bodyLimit: 512 * 1024,
  });
  app.decorate('db', opts.db);
  app.decorate('config', opts.config);
  app.decorateRequest('auth', null);

  await app.register(cors, {
    origin: opts.config.corsOrigins.length ? opts.config.corsOrigins : false,
    credentials: false,
  });
  if (opts.config.rateLimit) await app.register(rateLimit, { global: false });

  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      req.auth = await resolveSession(app.db, h.slice(7).trim(), app.config.sessionDays);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 413) return reply.status(413).send({ error: 'too_large', message: 'Arquivo grande demais.' });
    if (e.statusCode === 415) return reply.status(415).send({ error: 'unsupported_type', message: 'Tipo de arquivo não aceito. Use PNG, JPEG ou WebP.' });
    if (e.statusCode === 429) return reply.status(429).send({ error: 'rate_limited', message: 'Muitas tentativas. Espere um pouco.' });
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Erro interno. Tente de novo.' });
  });

  // logo do clube: o corpo é o próprio arquivo de imagem
  app.addContentTypeParser(LOGO_TYPES, { parseAs: 'buffer', bodyLimit: opts.config.logoMaxBytes }, (_req, body, done) => done(null, body));

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(catalogRoutes);
    await api.register(clubRoutes);
    await api.register(importRoutes);
    await api.register(memberRoutes);
    await api.register(progressRoutes);
    await api.register(brandingRoutes);
    await api.register(billingRoutes);
    await api.register(adminRoutes);
  }, { prefix: '/api' });

  if (opts.config.serveFrontend) {
    await app.register(fastifyStatic, {
      root: fileURLToPath(new URL('../../', import.meta.url)),
      allowedPath: (path) => path === '/' || path === '/index.html',
      index: 'index.html',
      wildcard: false,
    });
  }

  return app;
}
