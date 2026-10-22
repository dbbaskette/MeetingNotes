// Check emitted JavaScript, not TypeScript source: both compilers must retain
// their own module format even when preload imports shared runtime types.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Script } from 'node:vm';

const root = new URL('../../', import.meta.url);
for (const name of fs.readdirSync(new URL('dist/electron/shared/', root))) {
  if (name.endsWith('.js')) await import(new URL(`dist/electron/shared/${name}`, root).href);
}
const { ActionItemsRepo } = await import(new URL('dist/electron/main/storage/action-items-repo.js', root).href);
const { ActionFilterSchema, resolveSpeakerLabels } = await import(new URL('dist/electron/shared/productivity.js', root).href);
assert.equal(typeof ActionItemsRepo, 'function');
assert.equal(ActionFilterSchema.parse({}).owner, 'mine');
assert.equal(resolveSpeakerLabels('SPEAKER_00 will follow up', { SPEAKER_00: 'Dan' }), 'Dan will follow up');

assert.equal(JSON.parse(fs.readFileSync(new URL('dist/preload/package.json', root), 'utf8')).type, 'commonjs');
for (const name of ['index', 'beta']) {
  const file = new URL(`dist/preload/electron/preload/${name}.js`, root);
  new Script(fs.readFileSync(file, 'utf8'), { filename: file.pathname });
}
console.log('PASS emitted runtime: shared ESM imports, Actions exports and isolated CommonJS preloads');
