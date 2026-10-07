import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { testCapture } from './capture-test.js';

it('tests only after explicit invocation, validates each finalized output and discards its owned folder', async () => {
  let output = '', level!: (id: string, source: string, peak: number) => void;
  const off = vi.fn();
  const manager = {
    on: (_event: string, callback: typeof level) => { level = callback; return off; },
    start: vi.fn(async (_input, internal) => {
      expect(internal.disposable).toBe(true);
      output = path.join(internal.outputDir, 'fixture.m4a');
      fs.writeFileSync(output, 'fixture'); return { sessionId: 'test', outputPath: output };
    }), stop: vi.fn(async () => {}), state: () => 'idle', active: () => [],
  };
  expect(manager.start).not.toHaveBeenCalled();
  const result = await testCapture(manager as never, { targetPid: 'system', targetLabel: 'All', mic: true }, {
    wait: async () => { level('test', 'mic', -12); level('test', 'mixed', -18); },
    probe: async file => { if (file.endsWith('.system.m4a')) throw new Error('empty app'); return { durationS: 8 }; },
  });
  expect(manager.stop).toHaveBeenCalledWith('test'); expect(off).toHaveBeenCalledOnce();
  expect(result.streams).toEqual({ Mic: { playable: true, peakDb: -12 }, App: { playable: false, peakDb: null }, File: { playable: true, peakDb: -18 } });
  expect(fs.existsSync(path.dirname(output))).toBe(false);
});

it('does not delete files still owned by an unconfirmed Stop', async () => {
  let dir = '';
  const manager = {
    on: () => () => {}, start: async (_input: unknown, internal: { outputDir: string }) => {
      dir = internal.outputDir; return { sessionId: 'test', outputPath: path.join(dir, 'fixture.m4a') };
    }, stop: async () => { throw new Error('exit not confirmed'); }, state: () => 'stopping', active: () => [],
  };
  try {
    await expect(testCapture(manager as never, { targetPid: 'system', targetLabel: 'All', mic: true }, { wait: async () => {} })).rejects.toThrow(/exit not confirmed/);
    expect(fs.existsSync(dir)).toBe(true);
  } finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } // fake helper has no process
});
