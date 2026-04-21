import { describe, it, expect, vi } from 'vitest';
import { RecordingManager } from './manager.js';

describe('RecordingManager', () => {
  it('start spawns helper with the right args', async () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    const fakeSpawn = (cmd: string, args: string[]): any => {
      spawned.push({ cmd, args });
      const stdoutCbs: ((c: string) => void)[] = [];
      return {
        pid: 12345,
        stdout: {
          on: (_: string, cb: (c: string) => void) => { stdoutCbs.push(cb); queueMicrotask(() => cb('{"event":"started"}\n')); },
          setEncoding: () => {},
        },
        stderr: { on: () => {}, setEncoding: () => {} },
        on: (_ev: string, _cb: any) => {},
        kill: () => {},
      };
    };
    const fakeRepo = {
      insert: vi.fn(), finalize: vi.fn(), markError: vi.fn(),
      findOpen: () => [], findOrphaned: () => [],
    } as any;

    const mgr = new RecordingManager({
      helperPath: '/bin/meeting-notes-tap',
      recordingsDir: '/tmp',
      repo: fakeRepo,
      spawn: fakeSpawn,
      clock: () => new Date('2026-04-20T19:23:00Z'),
    });
    const { sessionId } = await mgr.start({ targetPid: 999, targetLabel: 'Zoom', mic: true });
    expect(sessionId).toBeTruthy();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.cmd).toBe('/bin/meeting-notes-tap');
    expect(spawned[0]!.args).toContain('--pid');
    expect(spawned[0]!.args).toContain('999');
    expect(spawned[0]!.args).toContain('--mic');
    expect(spawned[0]!.args).toContain('--out');
    expect(fakeRepo.insert).toHaveBeenCalled();
  });

  it('start with system-audio passes --system-audio', async () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    const fakeSpawn = (cmd: string, args: string[]): any => {
      spawned.push({ cmd, args });
      return {
        pid: 1, stdout: { on: (_: string, cb: any) => queueMicrotask(() => cb('{"event":"started"}\n')), setEncoding: () => {} },
        stderr: { on: () => {}, setEncoding: () => {} },
        on: () => {}, kill: () => {},
      };
    };
    const fakeRepo = { insert: vi.fn(), finalize: vi.fn(), markError: vi.fn(), findOpen: () => [], findOrphaned: () => [] } as any;
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo: fakeRepo, spawn: fakeSpawn });
    await mgr.start({ targetPid: 'system', targetLabel: 'All system audio', mic: false });
    expect(spawned[0]!.args).toContain('--system-audio');
    expect(spawned[0]!.args).toContain('--no-mic');
  });
});
