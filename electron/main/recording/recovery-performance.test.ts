import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordingRecoveryService } from './recovery.js';
import { probeAudio } from '../library/ffprobe.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(count = 1, probe = vi.fn(async (_file: string) => ({ durationS: 1 }))) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-recovery-perf-'));
  dirs.push(dir);
  const sessions = Array.from({ length: count }, (_, i) => ({
    id: String(i), outputPath: path.join(dir, `${i}.wav`), targetLabel: 'Zoom',
    startedAt: '2026-09-08T00:00:00Z', status: 'orphaned', dismissedAt: null,
  }));
  for (const session of sessions) fs.writeFileSync(session.outputPath, 'audio');
  const service = new RecordingRecoveryService({
    sessions: { findRecoverable: () => sessions, findById: (id: string) => sessions.find(s => s.id === id) } as any,
    meetings: { findByAudioPath: () => null } as any,
    probe, catalog: vi.fn(), reveal: vi.fn(),
  });
  return { sessions, service, probe };
}

describe('recovery probe cache and concurrency', () => {
  it('retries transient probe failures after a cooldown without requiring file changes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const probe = vi.fn(async (_file: string): Promise<{ durationS: number }> => { throw new Error('timeout'); });
    const { service } = fixture(1, probe);
    expect(await service.list()).toMatchObject([{ canRecover: false }]);
    probe.mockResolvedValue({ durationS: 2 });
    await service.list();
    expect(probe).toHaveBeenCalledTimes(1);
    now.mockReturnValue(31_001);
    expect(await service.list()).toMatchObject([{ canRecover: true }]);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it('reuses unchanged probes and invalidates size, time, missing and recreated files', async () => {
    const { sessions, service, probe } = fixture();
    const file = sessions[0]!.outputPath;
    await service.list(); await service.list();
    expect(probe).toHaveBeenCalledTimes(1);
    fs.appendFileSync(file, 'changed');
    await service.list();
    expect(probe).toHaveBeenCalledTimes(2);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await service.list();
    expect(probe).toHaveBeenCalledTimes(3);
    fs.unlinkSync(file);
    expect(await service.list()).toMatchObject([{ canRecover: false }]);
    fs.writeFileSync(file, 'new');
    await service.list();
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('invalidates stems independently and preserves classification', async () => {
    const { sessions, service, probe } = fixture();
    const primary = sessions[0]!.outputPath;
    fs.writeFileSync(primary, '');
    const voice = primary.replace('.wav', '.voice.wav');
    fs.writeFileSync(voice, 'voice');
    expect(await service.list()).toMatchObject([{ reason: 'microphone-only' }]);
    await service.list();
    expect(probe).toHaveBeenCalledTimes(1);
    fs.unlinkSync(voice);
    expect(await service.list()).toMatchObject([{ reason: 'unreadable' }]);
  });

  it('streams 113 entries before completion, shares overlapping probes and caps active processes at four', async () => {
    let active = 0; let peak = 0;
    const probe = vi.fn(async (_file: string) => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return { durationS: 1 };
    });
    const { service } = fixture(113, probe);
    let complete = false;
    const received: number[] = [];
    const a = service.list((_item, index) => {
      expect(complete).toBe(false);
      received.push(index);
    }).then(items => { complete = true; return items; });
    const [first, second] = await Promise.all([a, service.list()]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(113);
    expect(new Set(received).size).toBe(113);
    expect(peak).toBe(4);
    expect(probe).toHaveBeenCalledTimes(113);
    await service.list();
    expect(probe).toHaveBeenCalledTimes(113);
  });

  it('releases slots after failed probes and retries after a file changes', async () => {
    const probe = vi.fn(async (_file: string): Promise<{ durationS: number }> => { throw new Error('bad'); });
    const { service, sessions } = fixture(8, probe);
    expect((await service.list()).every(item => !item.canRecover)).toBe(true);
    probe.mockResolvedValue({ durationS: 2 });
    fs.appendFileSync(sessions[0]!.outputPath, 'repaired');
    expect((await service.list())[0]!.canRecover).toBe(true);
  });
});

it.skipIf(!process.env.MN_RECOVERY_BENCH)('benchmarks 113 real WAV probes against the original sequential algorithm', async () => {
  const { service, sessions } = fixture(113, vi.fn(probeAudio));
  const wav = Buffer.alloc(44 + 16000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  for (const session of sessions) fs.writeFileSync(session.outputPath, wav);
  const rows = [];
  for (let run = 0; run < 3; run++) {
    // Change fingerprints between runs to reset only the optimized cache.
    for (const session of sessions) fs.utimesSync(session.outputPath, new Date(), new Date(Date.now() + run * 5000));
    const baseline = async () => { for (const session of sessions) await probeAudio(session.outputPath); };
    let start = performance.now(); await baseline(); const baselineCold = performance.now() - start;
    start = performance.now(); await baseline(); const baselineWarm = performance.now() - start;
    let firstMs = 0;
    start = performance.now();
    await service.list(() => { if (!firstMs) firstMs = performance.now() - start; });
    const cold = performance.now() - start;
    start = performance.now(); await service.list(); const warm = performance.now() - start;
    rows.push({ run, baselineCold, baselineWarm, cold, warm, firstMs });
  }
  console.log('RECOVERY_BENCH', JSON.stringify(rows));
}, 120000);
