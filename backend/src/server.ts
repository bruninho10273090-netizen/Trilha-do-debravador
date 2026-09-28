import { buildApp } from './app.js';
import { purgeExpiredSessions } from './auth/session.js';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/index.js';

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl);
await runMigrations(db);

const app = await buildApp({ db, config, logger: true });
const purge = setInterval(() => purgeExpiredSessions(db).catch((e) => app.log.warn(e)), 6 * 60 * 60 * 1000);

const close = async () => {
  clearInterval(purge);
  await app.close();
  await client.end();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

await app.listen({ port: config.port, host: config.host });
