import { EventEmitter } from 'node:events';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  RecordingManager,
  SILENCE_THRESHOLD_DB,
  SILENCE_TIMEOUT_MS,
} from './manager.js';

function fakeRepo(): any {
  return {
    insert: vi.fn(),
    finalize: vi.fn(),
    markError: vi.fn(),
    findOpen: () => [],
    findOrphaned: () => [],
  };
}

function fakeRecordingProcess(opts: { autoExitOnTerm?: boolean } = {}): {
  proc: any;
  stdout: EventEmitter;
} {
  const stdout = new EventEmitter();
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.stdout = stdout;
  proc.stdout.setEncoding = () => {};
  proc.stderr = { on: () => {}, setEncoding: () => {} };
  proc.kill = vi.fn((signal: string) => {
    if (signal === 'SIGTERM' && opts.autoExitOnTerm !== false) {
      queueMicrotask(() => proc.emit('exit', 0));
    }
    return true;
  });
  queueMicrotask(() => stdout.emit('data', '{"event":"started"}\n'));
  return { proc, stdout };
}

afterEach(() => {
  vi.useRealTimers();
});

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
    const repo = fakeRepo();

    const mgr = new RecordingManager({
      helperPath: '/bin/meeting-notes-tap',
      recordingsDir: '/tmp',
      repo,
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
    expect(repo.insert).toHaveBeenCalled();
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
    const repo = fakeRepo();
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn: fakeSpawn });
    await mgr.start({ targetPid: 'system', targetLabel: 'All system audio', mic: false });
    expect(spawned[0]!.args).toContain('--system-audio');
    expect(spawned[0]!.args).toContain('--no-mic');
  });

  it('auto-stops after five minutes without any level events', async () => {
    vi.useFakeTimers();
    const repo = fakeRepo();
    const onAutoStop = vi.fn();
    const { proc } = fakeRecordingProcess();
    const mgr = new RecordingManager({
      helperPath: '/h',
      recordingsDir: '/tmp',
      repo,
      spawn: () => proc,
      onAutoStop,
    });

    const { sessionId } = await mgr.start({ targetPid: 9, targetLabel: 'Zoom', mic: true });
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS);

    expect(onAutoStop).toHaveBeenCalledWith(sessionId, SILENCE_TIMEOUT_MS);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(repo.finalize).toHaveBeenCalledTimes(1);
    expect(mgr.state(sessionId)).toBe('idle');
  });

  it('resets the full timeout after an audible peak', async () => {
    vi.useFakeTimers();
    const repo = fakeRepo();
    const onAutoStop = vi.fn();
    const { proc, stdout } = fakeRecordingProcess();
    const mgr = new RecordingManager({
      helperPath: '/h',
      recordingsDir: '/tmp',
      repo,
      spawn: () => proc,
      onAutoStop,
    });

    const { sessionId } = await mgr.start({ targetPid: 9, targetLabel: 'Zoom', mic: true });
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - 1);
    stdout.emit('data', `{"event":"level","peak_db":${SILENCE_THRESHOLD_DB + 1}}\n`);
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - 1);
    expect(mgr.state(sessionId)).toBe('recording');
    expect(onAutoStop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    expect(repo.finalize).toHaveBeenCalledTimes(1);
  });

  it('does not reset for a peak exactly at the silence threshold', async () => {
    vi.useFakeTimers();
    const repo = fakeRepo();
    const onAutoStop = vi.fn();
    const { proc, stdout } = fakeRecordingProcess();
    const mgr = new RecordingManager({
      helperPath: '/h',
      recordingsDir: '/tmp',
      repo,
      spawn: () => proc,
      onAutoStop,
    });

    await mgr.start({ targetPid: 9, targetLabel: 'Zoom', mic: true });
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS / 2);
    stdout.emit('data', `{"event":"level","peak_db":${SILENCE_THRESHOLD_DB}}\n`);
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS / 2);

    expect(onAutoStop).toHaveBeenCalledTimes(1);
    expect(repo.finalize).toHaveBeenCalledTimes(1);
  });

  it('manual stop clears the pending watchdog', async () => {
    vi.useFakeTimers();
    const repo = fakeRepo();
    const onAutoStop = vi.fn();
    const { proc } = fakeRecordingProcess();
    const mgr = new RecordingManager({
      helperPath: '/h',
      recordingsDir: '/tmp',
      repo,
      spawn: () => proc,
      onAutoStop,
    });

    const { sessionId } = await mgr.start({ targetPid: 9, targetLabel: 'Zoom', mic: true });
    await mgr.stop(sessionId);
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS);

    expect(onAutoStop).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(repo.finalize).toHaveBeenCalledTimes(1);
  });

  it('manual and automatic stop racing signal and finalize once', async () => {
    vi.useFakeTimers();
    const repo = fakeRepo();
    const onAutoStop = vi.fn();
    const { proc } = fakeRecordingProcess({ autoExitOnTerm: false });
    const mgr = new RecordingManager({
      helperPath: '/h',
      recordingsDir: '/tmp',
      repo,
      spawn: () => proc,
      onAutoStop,
    });

    const { sessionId } = await mgr.start({ targetPid: 9, targetLabel: 'Zoom', mic: true });
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS);
    const manualStop = mgr.stop(sessionId);
    proc.emit('exit', 0);
    await manualStop;

    expect(onAutoStop).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(repo.finalize).toHaveBeenCalledTimes(1);
    expect(mgr.state(sessionId)).toBe('idle');
  });

  it('helper self-exit clears the watchdog and finalizes once', async () => {
    vi.useFakeTimers();
    const repo = fakeRepo();
    const onAutoStop = vi.fn();
    const { proc } = fakeRecordingProcess({ autoExitOnTerm: false });
    const mgr = new RecordingManager({
      helperPath: '/h',
      recordingsDir: '/tmp',
      repo,
      spawn: () => proc,
      onAutoStop,
    });

    const { sessionId } = await mgr.start({ targetPid: 9, targetLabel: 'Zoom', mic: true });
    proc.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS);

    expect(onAutoStop).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
    expect(repo.finalize).toHaveBeenCalledTimes(1);
    expect(mgr.state(sessionId)).toBe('idle');
  });
});
