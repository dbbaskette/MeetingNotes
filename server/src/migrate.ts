import { readFile } from 'node:fs/promises';
import { Store } from './db.js';
import { loadConfig } from './config.js';
const store = new Store(loadConfig().DATABASE_URL);
try {
  await store.pool.query(
    await readFile(new URL('../migrations/001-jobs.sql', import.meta.url), 'utf8'),
  );
} finally {
  await store.close();
}
