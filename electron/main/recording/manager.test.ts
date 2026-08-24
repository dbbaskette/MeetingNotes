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
  it('marks the session row error and clears state when the helper exits before started', async () => {
    const stdout = new EventEmitter();
    const proc = new EventEmitter() as any;
    proc.pid = 4242;
    proc.stdout = stdout; proc.stdout.setEncoding = () => {};
    proc.stderr = { on: () => {}, setEncoding: () => {} };
    proc.kill = vi.fn();
    queueMicrotask(() => proc.emit('exit', 1)); // dies before "started"
    const repo = fakeRepo();
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn: () => proc } as any);
    await expect(mgr.start({ targetPid: 'system', targetLabel: 'All', mic: true } as any))
      .rejects.toThrow(/exited before started/);
    // The row must not stay 'recording' — it suppresses auto-detect and
    // blocks every later meetingnotes://record with "Already recording".
    expect(repo.markError).toHaveBeenCalled();
    const sessionId = repo.insert.mock.calls[0][0].id;
    expect(mgr.state(sessionId)).toBe('idle');
  });

  it('rejects instead of hanging when spawn itself fails (error event, no exit)', async () => {
    const stdout = new EventEmitter();
    const proc = new EventEmitter() as any;
    proc.pid = undefined; // exactly what node returns for a bad binary path
    proc.stdout = stdout; proc.stdout.setEncoding = () => {};
    proc.stderr = { on: () => {}, setEncoding: () => {} };
    proc.kill = vi.fn();
    queueMicrotask(() => proc.emit('error', new Error('ENOENT'))); // never 'exit'
    const repo = fakeRepo();
    const mgr = new RecordingManager({ helperPath: '/nonexistent', recordingsDir: '/tmp', repo, spawn: () => proc } as any);
    await expect(mgr.start({ targetPid: 'system', targetLabel: 'All', mic: true } as any))
      .rejects.toThrow(/failed to spawn/);
    expect(repo.markError).toHaveBeenCalled();
  });

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

  it('forwards source-aware levels and treats legacy events as mixed', async () => {
    const repo = fakeRepo();
    const { proc, stdout } = fakeRecordingProcess();
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn: () => proc });
    const levels: Array<[string, string, number]> = [];
    mgr.on('level', (sessionId, source, peakDb) => levels.push([sessionId, source, peakDb]));

    const { sessionId } = await mgr.start({ targetPid: 9, targetLabel: 'Zoom', mic: true });
    stdout.emit('data', '{"event":"level","source":"mic","peak_db":-12}\n');
    stdout.emit('data', '{"event":"level","peak_db":-18}\n');

    expect(levels).toEqual([
      [sessionId, 'mic', -12],
      [sessionId, 'mixed', -18],
    ]);
    await mgr.stop(sessionId);
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
