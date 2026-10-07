import { EventEmitter } from 'node:events';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db.js';
import { RecordingSessionsRepo } from '../storage/recording-sessions-repo.js';
import {
  RecordingManager,
  SILENCE_THRESHOLD_DB,
  SILENCE_TIMEOUT_MS,
} from './manager.js';

function fakeRepo() {
  const repo = {
    insert: vi.fn(),
    updateHelperPid: vi.fn(),
    finalize: vi.fn(),
    markError: vi.fn(),
    findOpen: () => [],
    findOrphaned: () => [],
  };
  return repo as typeof repo & RecordingSessionsRepo;
}

function fakeRecordingProcess(opts: { autoExitOnTerm?: boolean; emitStarted?: boolean } = {}) {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const proc = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout,
    stderr: { on: () => {}, setEncoding: () => {} },
    kill: vi.fn((signal: string) => {
      if (signal === 'SIGTERM' && opts.autoExitOnTerm !== false) {
        queueMicrotask(() => proc.emit('exit', 0));
      }
      return true;
    }),
  }) as unknown as ChildProcessWithoutNullStreams;
  if (opts.emitStarted !== false) queueMicrotask(() => stdout.emit('data', '{"event":"started"}\n'));
  return { proc, stdout };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RecordingManager', () => {
  it('rejects a stale start intent after a Stop command', async () => {
    const spawn = vi.fn();
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo: fakeRepo(), spawn });
    const expectedRevision = mgr.startRevision; mgr.cancelPendingStarts();
    await expect(mgr.start({ targetPid: 'system', targetLabel: 'All', mic: true }, { expectedRevision })).rejects.toThrow(/cancelled/);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('releases a never-ready capture after a late exit beyond the Stop deadline, without auto-processing', async () => {
    vi.useFakeTimers(); const repo = fakeRepo(), finalized = vi.fn();
    const { proc } = fakeRecordingProcess({ emitStarted: false, autoExitOnTerm: false });
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn: () => proc, onFinalized: finalized });
    const rejected = expect(mgr.start({ targetPid: 'system', targetLabel: 'All', mic: false })).rejects.toThrow(/15 seconds/);
    await vi.advanceTimersByTimeAsync(22001); await rejected;
    expect(mgr.active()).toHaveLength(1); proc.emit('exit', 0);
    expect(mgr.active()).toHaveLength(0); expect(repo.finalize).toHaveBeenCalledOnce(); expect(finalized).not.toHaveBeenCalled();
  });
  it('isolates explicit disposable capture while sharing the global slot', async () => {
    const repo = fakeRepo(), finalized = vi.fn();
    const { proc } = fakeRecordingProcess();
    const manager = new RecordingManager({ helperPath: '/h', recordingsDir: '/library', repo, spawn: () => proc, onFinalized: finalized });
    const input = { targetPid: 'system' as const, targetLabel: 'All', mic: true };
    const result = await manager.start(input, { outputDir: '/tmp/owned-test', disposable: true });
    expect(result.outputPath.startsWith('/tmp/owned-test/')).toBe(true);
    expect(repo.insert).not.toHaveBeenCalled();
    await expect(manager.start(input)).rejects.toThrow(/Already recording/);
    await manager.stop(result.sessionId);
    expect(repo.finalize).not.toHaveBeenCalled(); expect(finalized).not.toHaveBeenCalled();
  });
  it('retains the slot after startup timeout until exit and allows a later retry', async () => {
    vi.useFakeTimers();
    const repo = fakeRepo(); const { proc } = fakeRecordingProcess({ emitStarted: false, autoExitOnTerm: false });
    const manager = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn: () => proc });
    const input = { targetPid: 'system' as const, targetLabel: 'All', mic: true };
    const rejected = expect(manager.start(input)).rejects.toThrow(/15 seconds/);
    await vi.advanceTimersByTimeAsync(15000); await rejected;
    await expect(manager.start(input)).rejects.toThrow(/Already recording/);
    proc.emit('exit', 0); await Promise.resolve(); await Promise.resolve();
    expect(manager.active()).toEqual([]);
  });
  it('claims one slot across concurrent starts, including startup and stopping', async () => {
    const repo = fakeRepo();
    const { proc, stdout } = fakeRecordingProcess({ emitStarted: false, autoExitOnTerm: false });
    const spawn = vi.fn(() => proc);
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn });
    const input = { targetPid: 'system' as const, targetLabel: 'All', mic: true };
    const pending = mgr.start(input);
    await expect(mgr.start(input)).rejects.toThrow(/Already recording/);
    stdout.emit('data', '{"event":"started"}\n');
    const { sessionId } = await pending;
    const stop = mgr.stop(sessionId);
    await expect(mgr.start(input)).rejects.toThrow(/Already recording/);
    proc.emit('exit', 0); await stop;
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('never finalizes an unconfirmed helper exit, and permits retry Stop', async () => {
    vi.useFakeTimers();
    const repo = fakeRepo();
    const { proc } = fakeRecordingProcess({ autoExitOnTerm: false });
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn: () => proc });
    const { sessionId } = await mgr.start({ targetPid: 'system', targetLabel: 'All', mic: false });
    const rejection = expect(mgr.stop(sessionId)).rejects.toThrow(/not confirmed exit/);
    await vi.advanceTimersByTimeAsync(7000); await rejection;
    expect(repo.finalize).not.toHaveBeenCalled();
    expect(mgr.state(sessionId)).toBe('stopping');
    const retry = mgr.stop(sessionId); proc.emit('exit', 0); await retry;
    expect(repo.finalize).toHaveBeenCalledTimes(1);
  });
  it('marks the session row error and clears state when the helper exits before started', async () => {
    const { proc } = fakeRecordingProcess({ emitStarted: false });
    proc.pid = 4242;
    queueMicrotask(() => proc.emit('exit', 1)); // dies before "started"
    const repo = fakeRepo();
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn: () => proc });
    await expect(mgr.start({ targetPid: 'system', targetLabel: 'All', mic: true }))
      .rejects.toThrow(/exited before started/);
    // The row must not stay 'recording' — it suppresses auto-detect and
    // blocks every later meetingnotes://record with "Already recording".
    expect(repo.markError).toHaveBeenCalled();
    const sessionId = repo.insert.mock.calls[0][0].id;
    expect(mgr.state(sessionId)).toBe('idle');
  });

  it('rejects instead of hanging when spawn itself fails (error event, no exit)', async () => {
    const { proc } = fakeRecordingProcess({ emitStarted: false });
    proc.pid = undefined; // exactly what node returns for a bad binary path
    queueMicrotask(() => proc.emit('error', new Error('ENOENT'))); // never 'exit'
    const repo = fakeRepo();
    const mgr = new RecordingManager({ helperPath: '/nonexistent', recordingsDir: '/tmp', repo, spawn: () => proc });
    await expect(mgr.start({ targetPid: 'system', targetLabel: 'All', mic: true }))
      .rejects.toThrow(/failed to spawn/);
    expect(repo.markError).toHaveBeenCalled();
  });

  it('does not resurrect a stopped startup when a buffered started event arrives', async () => {
    const repo = fakeRepo();
    const { proc, stdout } = fakeRecordingProcess({ emitStarted: false, autoExitOnTerm: false });
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn: () => proc });
    const states: string[] = [];
    mgr.on('state-change', (_id, state) => states.push(state));
    const start = mgr.start({ targetPid: 'system', targetLabel: 'All', mic: true });
    const rejected = expect(start).rejects.toThrow(/stopped before capture started|exited before started/);
    const sessionId = repo.insert.mock.calls[0]![0].id;
    const stop = mgr.stop(sessionId);
    stdout.emit('data', '{"event":"started"}\n');
    proc.emit('exit', 0);
    await Promise.all([rejected, stop]);
    expect(states).not.toContain('recording');
    expect(repo.markError).not.toHaveBeenCalled();
    expect(repo.finalize).toHaveBeenCalledTimes(1);
    expect(mgr.state(sessionId)).toBe('idle');
  });

  it('preserves stop finalization when the helper exits without a started event', async () => {
    const repo = fakeRepo();
    const { proc } = fakeRecordingProcess({ emitStarted: false, autoExitOnTerm: false });
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn: () => proc });
    const start = mgr.start({ targetPid: 'system', targetLabel: 'All', mic: false });
    const rejected = expect(start).rejects.toThrow(/exited before started/);
    const sessionId = repo.insert.mock.calls[0]![0].id;
    const stop = mgr.stop(sessionId);
    proc.emit('exit', 0);
    await Promise.all([rejected, stop]);
    expect(repo.markError).not.toHaveBeenCalled();
    expect(repo.finalize).toHaveBeenCalledTimes(1);
    expect(mgr.state(sessionId)).toBe('idle');
  });

  it('rejects a helper that emits started and exits in the same turn', async () => {
    const repo = fakeRepo();
    const { proc, stdout } = fakeRecordingProcess({ emitStarted: false });
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn: () => proc });
    queueMicrotask(() => {
      stdout.emit('data', '{"event":"started"}\n');
      proc.emit('exit', 1);
    });
    await expect(mgr.start({ targetPid: 'system', targetLabel: 'All', mic: false }))
      .rejects.toThrow(/exited before started/);
    const sessionId = repo.insert.mock.calls[0]![0].id;
    expect(repo.markError).toHaveBeenCalledWith(sessionId);
    expect(mgr.state(sessionId)).toBe('idle');
  });

  it.each(['spawn-throw', 'spawn-error', 'early-exit'])('allows another recording after %s without an open database row', async (failure) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-start-recovery-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    try {
      const repo = new RecordingSessionsRepo(db);
      let attempts = 0;
      const mgr = new RecordingManager({
        helperPath: '/fake-helper', recordingsDir: dir, repo,
        spawn: () => {
          attempts++;
          if (attempts !== 1) return fakeRecordingProcess().proc;
          if (failure === 'spawn-throw') throw new Error('spawn refused');
          const { proc } = fakeRecordingProcess({ emitStarted: false });
          if (failure === 'spawn-error') Object.assign(proc, { pid: undefined }); // ENOENT never spawns a process
          queueMicrotask(() => failure === 'spawn-error'
            ? proc.emit('error', new Error('ENOENT')) : proc.emit('exit', 1));
          return proc;
        },
      });
      await expect(mgr.start({ targetPid: 'system', targetLabel: 'Failed', mic: false })).rejects.toThrow();
      expect(repo.findOpen()).toHaveLength(0);
      expect(repo.findRecoverable()).toHaveLength(1);
      expect(repo.findRecoverable()[0]!.status).toBe('error');
      const { sessionId } = await mgr.start({ targetPid: 'system', targetLabel: 'Retry', mic: false });
      expect(repo.findOpen()).toHaveLength(1);
      expect(mgr.state(sessionId)).toBe('recording');
      await mgr.stop(sessionId);
      expect(repo.findOpen()).toHaveLength(0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start spawns helper with the right args', async () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    const fakeSpawn = (cmd: string, args: string[]): ChildProcessWithoutNullStreams => {
      expect(repo.insert).toHaveBeenCalled(); // capture intent is durable before helper starts
      spawned.push({ cmd, args });
      const stdoutCbs: ((c: string) => void)[] = [];
      return {
        pid: 12345,
        stdout: {
          on: (_: string, cb: (c: string) => void) => { stdoutCbs.push(cb); queueMicrotask(() => cb('{"event":"started"}\n')); },
          setEncoding: () => {},
        },
        stderr: { on: () => {}, setEncoding: () => {} },
        on: () => {},
        kill: () => {},
      } as unknown as ChildProcessWithoutNullStreams;
    };
    const repo = fakeRepo();

    const mgr = new RecordingManager({
      helperPath: '/bin/meeting-notes-tap',
      recordingsDir: '/tmp',
      repo,
      spawn: fakeSpawn,
      clock: () => new Date('2026-04-20T19:23:00Z'),
    });
    const groupId = '6d73201f-33ab-45ba-b021-39140ee219d7';
    const { sessionId } = await mgr.start({ targetPid: 999, targetLabel: 'Zoom', mic: true, groupId });
    expect(sessionId).toBeTruthy();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.cmd).toBe('/bin/meeting-notes-tap');
    expect(spawned[0]!.args).toContain('--pid');
    expect(spawned[0]!.args).toContain('999');
    expect(spawned[0]!.args).toContain('--mic');
    expect(spawned[0]!.args).toContain('--out');
    expect(repo.insert).toHaveBeenCalled();
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ groupId, helperPid: -1 }));
    expect(repo.updateHelperPid).toHaveBeenCalledWith(sessionId, 12345);
  });

  it('start with system-audio passes --system-audio', async () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    const fakeSpawn = (cmd: string, args: string[]): ChildProcessWithoutNullStreams => {
      spawned.push({ cmd, args });
      return {
        pid: 1, stdout: { on: (_: string, cb: (chunk: string) => void) => queueMicrotask(() => cb('{"event":"started"}\n')), setEncoding: () => {} },
        stderr: { on: () => {}, setEncoding: () => {} },
        on: () => {}, kill: () => {},
      } as unknown as ChildProcessWithoutNullStreams;
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
