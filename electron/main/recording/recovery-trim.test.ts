import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ffmpegPath } from '../lib/find-ffmpeg.js';
import { probeAudio } from '../library/ffprobe.js';
import { RecordingRecoveryService } from './recovery.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup(real = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-trim-')); dirs.push(dir);
  const primary = path.join(dir, 'call #1.m4a'); fs.writeFileSync(primary, 'original');
  const session = { id: 's', outputPath: primary, dismissedAt: null };
  const dismiss = vi.fn();
  const trim = vi.fn(async (_src: string, dest: string, _end: number, _start: number) => { fs.writeFileSync(dest, 'trimmed'); });
  const catalog = vi.fn(async (_p: string) => ({ meeting: { id: 'm' } }));
  const service = new RecordingRecoveryService({
    sessions: { findById: () => session, dismissRecovery: dismiss } as any,
    meetings: {} as any, probe: async () => ({ durationS: 100 }),
    catalog: catalog as any, reveal: vi.fn(), trim: real ? undefined : trim,
  });
  return { service, primary, trim, catalog, dismiss, session };
}
describe('recovery preview and range trim', () => {
  it.skipIf(!process.env.MN_RECOVERY_TRIM_REAL)('trims a real nonzero-start M4A without changing the source', async () => {
    const { service, primary, catalog } = setup(true);
    execFileSync(ffmpegPath(), ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'aac', primary], { stdio: 'ignore' });
    const original = fs.readFileSync(primary);
    await service.trim('s', 3, 1);
    const info = await probeAudio(catalog.mock.calls[0]![0]);
    expect(info.durationS).toBeGreaterThan(1.8); expect(info.durationS).toBeLessThan(2.2);
    expect(fs.readFileSync(primary)).toEqual(original);
  });
  it('previews and trims the system-only stem', async () => {
    const { service, primary, trim } = setup();
    fs.writeFileSync(primary, '');
    const system = primary.replace('.m4a', '.system.m4a'); fs.writeFileSync(system, 'system');
    expect(fileURLToPath((await service.preview('s')).url)).toBe(system);
    await service.trim('s', 20, 10);
    expect(trim.mock.calls[0]![0]).toBe(system);
  });
  it('previews the usable stem and URL-encodes the path', async () => {
    const { service, primary } = setup();
    fs.writeFileSync(primary, '');
    const voice = primary.replace('.m4a', '.voice.m4a'); fs.writeFileSync(voice, 'voice');
    expect(fileURLToPath((await service.preview('s')).url)).toBe(voice);
    expect((await service.preview('s')).durationS).toBe(100);
  });
  it('passes start/end to trim, catalogs a distinct copy and preserves the original', async () => {
    const { service, primary, trim, catalog, dismiss } = setup();
    expect(await service.trim('s', 70, 20)).toEqual({ meetingId: 'm' });
    expect(trim).toHaveBeenCalledWith(primary, expect.any(String), 70, 20);
    const output = trim.mock.calls[0]![1];
    expect(output).not.toBe(primary);
    expect(fs.readFileSync(primary, 'utf8')).toBe('original');
    expect(catalog).toHaveBeenCalledWith(output);
    expect(dismiss).toHaveBeenCalledWith('s');
  });
  it.each([[NaN, 0], [Infinity, 0], [10, -1], [10, 10], [5, 10], [101, 0], [10, NaN]])('rejects invalid range end=%s start=%s', async (end, start) => {
    const { service, trim, catalog, dismiss } = setup();
    await expect(service.trim('s', end, start)).rejects.toThrow();
    expect(trim).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();
  });
  it('keeps old two-argument calls and generates unique destinations', async () => {
    const { service, trim } = setup();
    await service.trim('s', 30); await service.trim('s', 30);
    expect(trim.mock.calls[0]![3]).toBe(0);
    expect(trim.mock.calls[0]![1]).not.toBe(trim.mock.calls[1]![1]);
  });
  it('blocks duplicate trim/recover/dismiss operations and unlocks after failure', async () => {
    const { service, trim, dismiss } = setup();
    let fail!: (err: Error) => void;
    trim.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const first = service.trim('s', 50);
    await vi.waitFor(() => expect(trim).toHaveBeenCalled());
    await expect(service.trim('s', 50)).rejects.toThrow('already');
    await expect(service.recover('s')).rejects.toThrow('already');
    expect(() => service.dismiss('s')).toThrow('Wait');
    fail(new Error('disk full')); await expect(first).rejects.toThrow('disk full');
    expect(dismiss).not.toHaveBeenCalled();
    await expect(service.trim('s', 50)).resolves.toEqual({ meetingId: 'm' });
  });
  it('rejects dismissed sessions and unreadable audio', async () => {
    const { service, primary, session } = setup();
    fs.writeFileSync(primary, '');
    await expect(service.preview('s')).rejects.toThrow('No playable');
    await expect(service.trim('s', 1)).rejects.toThrow('cannot');
    Object.assign(session, { dismissedAt: 'now' });
    await expect(service.preview('s')).rejects.toThrow('not found');
  });
});
