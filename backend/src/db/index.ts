import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import * as schema from './schema.js';

export function createDb(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema, casing: 'snake_case' });
  return { db, client };
}

export type Db = ReturnType<typeof createDb>['db'];
/** Transação ou conexão: as funções de serviço aceitam os dois. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder });
}
