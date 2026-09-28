import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations } from '../src/db/index.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://trilha:trilha@localhost:5432/trilha_test';

/** Sobe a API num banco de teste zerado. */
export async function setup() {
  const config = { ...loadConfig({ DATABASE_URL: TEST_DB, SERVE_FRONTEND: 'false', RATE_LIMIT: 'false' }) };
  const { db, client } = createDb(TEST_DB);
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await runMigrations(db);
  const app = await buildApp({ db, config });
  await app.ready();
  return { app, db, close: async () => { await app.close(); await client.end(); } };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export function client(app: FastifyInstance, token?: string) {
  const call = async (method: Method, url: string, body?: unknown) => {
    const res = await app.inject({
      method, url: '/api' + url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  return {
    get: (u: string) => call('GET', u),
    post: (u: string, b: unknown = {}) => call('POST', u, b),
    patch: (u: string, b: unknown) => call('PATCH', u, b),
    del: (u: string, b?: unknown) => call('DELETE', u, b),
  };
}

let n = 0;
/** Cria uma conta e devolve um cliente autenticado. */
export async function newUser(app: FastifyInstance, extra: { name?: string; birth?: string; username?: string } = {}) {
  const username = extra.username ?? `user${++n}${Date.now() % 10000}`;
  const res = await client(app).post('/auth/register', {
    username, name: extra.name ?? `Pessoa ${n}`, password: 'senha-forte-123', birth: extra.birth,
  });
  if (res.status !== 201) throw new Error('register falhou: ' + JSON.stringify(res.body));
  return { ...client(app, res.body.token), token: res.body.token as string, user: res.body.user, username };
}
