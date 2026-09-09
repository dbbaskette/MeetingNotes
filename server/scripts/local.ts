import { readFile } from 'node:fs/promises';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { testConfig, TOKEN } from '../tests/helpers.js';
import { Store } from '../src/db.js';
import { Objects } from '../src/objects.js';
import { buildApi } from '../src/api.js';
import { runWorker } from '../src/worker.js';
// Explicit synthetic-only convenience entry point. It never reads any library files.
const c = testConfig();
c.S3_BUCKET = 'meetingnotes-synthetic-local';
c.PORT = 58800;
const action = process.argv[2];
if (action === 'setup') {
  const store = new Store(c.DATABASE_URL),
    objects = new Objects(c);
  try {
    await store.pool.query(
      await readFile(new URL('../migrations/001-jobs.sql', import.meta.url), 'utf8'),
    );
    try {
      await objects.client.send(new CreateBucketCommand({ Bucket: c.S3_BUCKET }));
    } catch (e) {
      if (
        !['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes((e as { name: string }).name)
      )
        throw e;
    }
    console.log('Synthetic storage ready.');
  } finally {
    objects.close();
    await store.close();
  }
} else if (action === 'api') {
  const app = buildApi(c);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void app.close());
  await app.listen({ host: '127.0.0.1', port: c.PORT });
  console.log(
    `Synthetic API http://127.0.0.1:${c.PORT}; use the public test fixture TOKEN in tests/helpers.ts. Token length ${TOKEN.length}; never use these credentials in production.`,
  );
} else if (action === 'worker') {
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
  await runWorker(c, controller.signal);
} else throw new Error('Use setup, api or worker');
