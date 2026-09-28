import { loadConfig } from '../config.js';
import { createDb, runMigrations } from './index.js';

const { db, client } = createDb(loadConfig().databaseUrl);
await runMigrations(db);
await client.end();
console.log('migrações aplicadas');
