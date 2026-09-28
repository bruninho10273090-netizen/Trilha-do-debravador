// Torna uma conta existente administradora da plataforma:
//   npm run make-admin -- <usuario>
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { users } from '../src/db/schema.js';

const username = process.argv[2]?.trim().toLowerCase();
if (!username) {
  console.error('uso: npm run make-admin -- <usuario>');
  process.exit(1);
}
const { db, client } = createDb(loadConfig().databaseUrl);
const rows = await db.update(users).set({ isPlatformAdmin: true })
  .where(sql`lower(${users.username}) = ${username}`).returning({ id: users.id });
await client.end();
if (!rows.length) {
  console.error(`conta "${username}" não encontrada; crie a conta pelo app primeiro`);
  process.exit(1);
}
console.log(`"${username}" agora é administrador da plataforma`);
