import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS as MAIN_CHANNELS } from '../main/ipc/contracts.js';

// Preload is CJS so we can't import it under vitest's ESM loader. Parse the
// IPC_CHANNELS entries out of the source file with a strict line regex —
// each entry is a single `key: 'value',` line. No code evaluation.
const preloadSrc = readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8');
const block = preloadSrc.match(/const IPC_CHANNELS = \{([\s\S]*?)\} as const;/);
if (!block) throw new Error('could not locate IPC_CHANNELS in preload source');

const PRELOAD_CHANNELS: Record<string, string> = {};
const ENTRY = /^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*'([^']+)'\s*,?\s*$/;
for (const line of block[1]!.split('\n')) {
  const m = line.match(ENTRY);
  if (m) PRELOAD_CHANNELS[m[1]!] = m[2]!;
}

describe('preload IPC_CHANNELS parity', () => {
  it('matches the main-process IPC_CHANNELS exactly', () => {
    expect(PRELOAD_CHANNELS).toEqual(MAIN_CHANNELS);
  });
});
