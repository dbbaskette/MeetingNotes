import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpeechClient } from './client.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function executable(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-speech-protocol-')); roots.push(root);
  const file = path.join(root, 'fake-helper'); fs.writeFileSync(file, '#!/bin/sh\nIFS= read -r request\n' + body, { mode: 0o700 }); return file;
}
it('rejects malformed protocol output without returning a partial result', async () => {
  const helper = executable("printf 'not-json\\n'\n");
  await expect(new SpeechClient(helper, 1000).request('health')).rejects.toThrow(/Invalid native speech/);
});
it('rejects an unexpected request ID', async () => {
  const helper = executable("printf '%s\\n' '{\"version\":1,\"id\":\"wrong\",\"kind\":\"result\",\"result\":{}}'\n");
  await expect(new SpeechClient(helper, 1000).request('health')).rejects.toThrow(/Invalid native speech/);
});
it('rejects an early exit rather than hanging', async () => {
  await expect(new SpeechClient(executable('exit 0\n'), 1000).request('health')).rejects.toThrow(/without a complete result/);
});
it('handles a missing helper with an actionable startup failure', async () => {
  await expect(new SpeechClient('/nonexistent/meeting-notes-speech', 1000).request('health')).rejects.toThrow(/could not start/);
});
it('cancels only its own request and does not wait for the normal timeout', async () => {
  const helper = executable('while :; do :; done\n'), controller = new AbortController();
  const promise = new SpeechClient(helper, 5000).request('transcribe', {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await expect(promise).rejects.toThrow(/cancelled/);
});
it('bounds hung helpers and rejects an already cancelled request', async () => {
  const helper = executable('while :; do :; done\n');
  await expect(new SpeechClient(helper, 30).request('health')).rejects.toThrow(/timed out/);
  const controller = new AbortController(); controller.abort();
  await expect(new SpeechClient(helper).request('health', {}, { signal: controller.signal })).rejects.toThrow(/cancelled/);
});
