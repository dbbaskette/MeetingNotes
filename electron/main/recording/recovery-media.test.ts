import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recoveryMediaHandler } from './recovery-media.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-media-')); dirs.push(dir);
  const file = path.join(dir, 'audio.wav'); fs.writeFileSync(file, '0123456789');
  return recoveryMediaHandler({ preview: async id => {
    if (id !== 'known') throw new Error('not found');
    return { url: pathToFileURL(file).href, durationS: 1 };
  } });
}
it.each([['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=8-', '89', 'bytes 8-9/10'], ['bytes=-3', '789', 'bytes 7-9/10']])('streams %s', async (range, body, contentRange) => {
  const response = await fixture()(new Request('recovery-audio://preview?id=known', { headers: { Range: range } }));
  expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe(contentRange);
  expect(await response.text()).toBe(body);
});
it.each(['bytes=20-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5'])('rejects invalid range %s', async range => {
  expect((await fixture()(new Request('recovery-audio://preview?id=known', { headers: { Range: range } }))).status).toBe(416);
});
it('streams full audio and rejects unknown IDs or hosts', async () => {
  const handle = fixture();
  const full = await handle(new Request('recovery-audio://preview?id=known'));
  expect(full.status).toBe(200); expect(await full.text()).toBe('0123456789');
  expect((await handle(new Request('recovery-audio://preview?id=unknown'))).status).toBe(404);
  expect((await handle(new Request('recovery-audio://other?id=known'))).status).toBe(400);
});
