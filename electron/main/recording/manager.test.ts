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
  REPEATING_DIAGNOSTIC_INTERVAL_MS,
  SILENCE_AUTO_STOP_REASON,
  SILENCE_POLICY_POLL_MS,
  SILENCE_PROMPT_MAX_MS,
  SILENCE_THRESHOLD_DB,
  type SilencePolicy,
  type SilencePrompt,
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
  it('retains allowlisted capture timing metadata without paths, names, invalid values or raw helper payloads', async () => {
    const onDiagnostic = vi.fn(), { proc, stdout } = fakeRecordingProcess();
    const manager = new RecordingManager({ helperPath: '/h', recordingsDir: '/synthetic', repo: fakeRepo(), spawn: () => proc, onDiagnostic });
    const result = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
    stdout.emit('data', JSON.stringify({ event: 'diag', stage: 'mic_format', sample_rate: 24000, channels: 1, requested_frames: 4096, device_name: 'private microphone', output_path: '/private/meeting.m4a' }) + '\n');
    stdout.emit('data', JSON.stringify({ event: 'diag', stage: 'capture_timing', source: 'mic', input_frames: 4096, converted_frames: 8192, callback_age_ms: 174.2, holdback_ms: 234.2, mic_late_frames: 0, system_late_frames: 0, content: 'private words' }) + '\n');
    stdout.emit('data', '{"event":"diag","stage":"capture_timing","source":"private-device","holdback_ms":-1,"callback_age_ms":1e400,"input_frames":"4096"}\n');
    stdout.emit('data', '{"event":"diag","stage":"not_a_known_stage","input_frames":123}\n');
    expect(onDiagnostic.mock.calls).toEqual([
      [result.sessionId, { stage: 'mic_format', sample_rate: 24000, channels: 1, requested_frames: 4096 }],
      [result.sessionId, { stage: 'capture_timing', source: 'mic', input_frames: 4096, converted_frames: 8192, callback_age_ms: 174.2, holdback_ms: 234.2, mic_late_frames: 0, system_late_frames: 0 }],
    ]);
    stdout.emit('data', '{"event":"diag","stage":"capture_timing_stop","holdback_ms":234.2,"mic_late_frames":10,"system_late_frames":0}\n');
    expect(onDiagnostic).toHaveBeenLastCalledWith(result.sessionId, { stage: 'capture_timing_stop', holdback_ms: 234.2, mic_late_frames: 10, system_late_frames: 0 });
    await manager.stop(result.sessionId);
  });
  it('reports a stalled and recovered app-audio tap without forwarding helper error text', async () => {
    const onDiagnostic = vi.fn(), { proc, stdout } = fakeRecordingProcess();
    const manager = new RecordingManager({ helperPath: '/h', recordingsDir: '/synthetic', repo: fakeRepo(), spawn: () => proc, onDiagnostic });
    const result = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
    stdout.emit('data', '{"event":"diag","stage":"tap_stalled","attempt":1,"stalled_ms":1000,"device_name":"private headset"}\n');
    stdout.emit('data', '{"event":"diag","stage":"tap_rebuild_failed","error":"private device detail"}\n');
    stdout.emit('data', '{"event":"diag","stage":"tap_recovered","attempt":2,"stalled_ms":2000}\n');
    expect(onDiagnostic.mock.calls).toEqual([
      [result.sessionId, { stage: 'tap_stalled', attempt: 1, stalled_ms: 1000 }],
      [result.sessionId, { stage: 'tap_recovered', attempt: 2, stalled_ms: 2000 }],
    ]);
    await manager.stop(result.sessionId);
  });
  it('retains app-audio tap format, device, callback, buffer and conversion numbers, and nothing else', async () => {
    const onDiagnostic = vi.fn(), { proc, stdout } = fakeRecordingProcess();
    const manager = new RecordingManager({ helperPath: '/h', recordingsDir: '/synthetic', repo: fakeRepo(), spawn: () => proc, onDiagnostic });
    const result = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
    const emit = (payload: Record<string, unknown>): boolean => stdout.emit('data', JSON.stringify({ event: 'diag', ...payload }) + '\n');
    emit({ stage: 'tap_format', tap_sr: 48000, agg_sr: 44100, sr: 44100, ch: 2, bits: 32, bytes_per_frame: 8, fmt_flags: 9, device_name: 'private headset' });
    emit({ stage: 'after_start', device_is_running: 1, agg_id: 91, tap_id: 92, stream_sr: 48000, stream_ch: 2 });
    emit({ stage: 'ioproc', fire: 1, abl_count: 1, buf0_bytes: 4096, buf0_chans: 2, frames: 512, buf_peaks: [0.25, 0.5] });
    emit({ stage: 'post_conv', out_frames: 512 });
    emit({ stage: 'stop', ioproc_fires_total: 90210 });
    // Out of range, wrong type, or not a number at all: dropped field by field.
    stdout.emit('data', '{"event":"diag","stage":"tap_format","tap_sr":-1,"agg_sr":"44100","sr":1e400,"ch":2,"bits":null,"fmt_flags":9007199254740993}\n');
    emit({ stage: 'post_conv', out_frames: '512' });
    expect(onDiagnostic.mock.calls).toEqual([
      [result.sessionId, { stage: 'tap_format', tap_sr: 48000, agg_sr: 44100, sr: 44100, ch: 2, bits: 32, bytes_per_frame: 8, fmt_flags: 9 }],
      [result.sessionId, { stage: 'after_start', device_is_running: 1, stream_sr: 48000, stream_ch: 2 }],
      [result.sessionId, { stage: 'ioproc', fire: 1, abl_count: 1, buf0_bytes: 4096, buf0_chans: 2, frames: 512 }],
      [result.sessionId, { stage: 'post_conv', out_frames: 512 }],
      [result.sessionId, { stage: 'stop', ioproc_fires_total: 90210 }],
      [result.sessionId, { stage: 'tap_format', ch: 2 }],
    ]);
    await manager.stop(result.sessionId);
  });
  it('records that app-audio conversion failed without the helper\'s error text', async () => {
    const onDiagnostic = vi.fn(), { proc, stdout } = fakeRecordingProcess();
    const manager = new RecordingManager({ helperPath: '/h', recordingsDir: '/synthetic', repo: fakeRepo(), spawn: () => proc, onDiagnostic });
    const result = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
    stdout.emit('data', '{"event":"diag","stage":"conv_err","err":"Optional(Error Domain=private device detail)"}\n');
    stdout.emit('data', '{"event":"diag","stage":"pcmbuf_nil"}\n');
    stdout.emit('data', '{"event":"diag","stage":"avaudiofile_write_err","err":"/private/meeting.m4a"}\n');
    expect(onDiagnostic.mock.calls).toEqual([
      [result.sessionId, { stage: 'conv_err' }],
      [result.sessionId, { stage: 'pcmbuf_nil' }],
    ]);
    await manager.stop(result.sessionId);
  });
  it('thins the diagnostics the helper repeats all recording long', async () => {
    vi.useFakeTimers();
    const onDiagnostic = vi.fn(), { proc, stdout } = fakeRecordingProcess();
    const manager = new RecordingManager({ helperPath: '/h', recordingsDir: '/synthetic', repo: fakeRepo(), spawn: () => proc, onDiagnostic });
    const result = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
    const heartbeat = (fires: number, running = 1): boolean =>
      stdout.emit('data', JSON.stringify({ event: 'diag', ioproc_fires: fires, device_is_running: running }) + '\n');
    const stages = (): unknown[] => onDiagnostic.mock.calls.map(([, d]) => d);
    // The once-a-second heartbeat: the first, then one a minute.
    heartbeat(94); heartbeat(188); heartbeat(282);
    expect(stages()).toEqual([{ stage: 'tap_heartbeat', ioproc_fires: 94, device_is_running: 1 }]);
    // The device stopping (or starting again) is reported at once.
    heartbeat(282, 0); heartbeat(282, 0); heartbeat(376, 1);
    expect(stages().slice(1)).toEqual([
      { stage: 'tap_heartbeat', ioproc_fires: 282, device_is_running: 0 },
      { stage: 'tap_heartbeat', ioproc_fires: 376, device_is_running: 1 },
    ]);
    await vi.advanceTimersByTimeAsync(REPEATING_DIAGNOSTIC_INTERVAL_MS);
    heartbeat(6000); heartbeat(6094);
    expect(stages()).toHaveLength(4);
    expect(stages()[3]).toEqual({ stage: 'tap_heartbeat', ioproc_fires: 6000, device_is_running: 1 });
    // A stage-less diagnostic without a callback count is not a heartbeat.
    stdout.emit('data', '{"event":"diag","device_is_running":1,"note":"private"}\n');
    expect(stages()).toHaveLength(4);
    // Per-callback detail: the first three, then one a minute.
    onDiagnostic.mockClear();
    for (const fire of [1, 2, 3, 200, 400]) stdout.emit('data', `{"event":"diag","stage":"ioproc","fire":${fire},"frames":512}\n`);
    expect(stages()).toEqual([1, 2, 3].map((fire) => ({ stage: 'ioproc', fire, frames: 512 })));
    await vi.advanceTimersByTimeAsync(REPEATING_DIAGNOSTIC_INTERVAL_MS);
    stdout.emit('data', '{"event":"diag","stage":"ioproc","fire":6000,"frames":512}\n');
    expect(stages()).toHaveLength(4);
    await manager.stop(result.sessionId);
  });
  it('isolates timing observer failures from audio levels and capture lifecycle', async () => {
    const { proc, stdout } = fakeRecordingProcess();
    const manager = new RecordingManager({ helperPath: '/h', recordingsDir: '/synthetic', repo: fakeRepo(), spawn: () => proc, onDiagnostic: () => { throw new Error('observer unavailable'); } });
    const levels = vi.fn(); manager.on('level', levels);
    const result = await manager.start({ targetPid: 'system', targetLabel: 'All', mic: true });
    expect(() => stdout.emit('data', '{"event":"diag","stage":"capture_timing","holdback_ms":240}\n{"event":"level","source":"mic","peak_db":-10}\n')).not.toThrow();
    expect(levels).toHaveBeenCalledWith(result.sessionId, 'mic', -10);
    expect(manager.state(result.sessionId)).toBe('recording');
    await manager.stop(result.sessionId);
  });
  it('persists the normalized optional title before spawning and keeps the source label separate',async()=>{
    const repo=fakeRepo(),{proc}=fakeRecordingProcess();
    const spawn=vi.fn(()=>{expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({title:'Platform planning',targetLabel:'Zoom'}));return proc;});
    const manager=new RecordingManager({helperPath:'/synthetic/helper',recordingsDir:'/synthetic',repo,spawn});
    const result=await manager.start({targetPid:'system',targetLabel:'Zoom',mic:true,title:'  Platform planning  '});
    await manager.stop(result.sessionId);
    expect(spawn).toHaveBeenCalledOnce();
    await expect(manager.start({targetPid:'system',targetLabel:'Zoom',mic:true,title:'a\nb'})).rejects.toThrow();
    expect(spawn).toHaveBeenCalledOnce();
  });
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
});

describe('RecordingManager silence prompt', () => {
  const PROMPT_AFTER = 120_000, COUNTDOWN = 60_000;

  async function recording(opts: { policy?: Partial<SilencePolicy>; autoExitOnTerm?: boolean; disposable?: boolean } = {}) {
    vi.useFakeTimers();
    const repo = fakeRepo(), onAutoStop = vi.fn();
    const { proc, stdout } = fakeRecordingProcess({ autoExitOnTerm: opts.autoExitOnTerm });
    // Mutable on purpose: the manager must read it again, not remember it.
    const policy: SilencePolicy = { autoStopOnSilence: true, promptAfterMs: PROMPT_AFTER, countdownMs: COUNTDOWN, ...opts.policy };
    const mgr = new RecordingManager({ helperPath: '/h', recordingsDir: '/tmp', repo, spawn: () => proc, onAutoStop, getSilencePolicy: () => policy });
    const prompts: SilencePrompt[] = [], cleared: string[] = [], states: [string, string | undefined][] = [];
    mgr.on('silence-prompt', (prompt) => prompts.push(prompt));
    mgr.on('silence-cleared', (id, reason) => cleared.push(`${id}:${reason}`));
    mgr.on('state-change', (_id, state, reason) => states.push([state, reason]));
    const { sessionId } = await mgr.start({ targetPid: 9, targetLabel: 'Zoom', mic: true },
      opts.disposable ? { disposable: true, outputDir: '/tmp/test-capture' } : {});
    const level = (peakDb: number, source = 'system'): boolean =>
      stdout.emit('data', JSON.stringify({ event: 'level', source, peak_db: peakDb }) + '\n');
    const advance = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);
    return { mgr, repo, proc, policy, onAutoStop, prompts, cleared, states, sessionId, level, advance };
  }

  it('prompts when every source has been silent for the window, keeps recording, then stops when nobody answers', async () => {
    const t = await recording();
    // Quiet levels from every source are still silence.
    t.level(SILENCE_THRESHOLD_DB - 20, 'mic'); t.level(SILENCE_THRESHOLD_DB - 30, 'system');
    await t.advance(PROMPT_AFTER - 1);
    expect(t.prompts).toEqual([]);
    await t.advance(1);
    const prompt = { sessionId: t.sessionId, silentForMs: PROMPT_AFTER, autoStopAtMs: Date.now() + COUNTDOWN };
    expect(t.prompts).toEqual([prompt]);
    expect(t.mgr.silenceState()).toEqual(prompt);
    // Phase 1 does not stop anything.
    expect(t.mgr.state(t.sessionId)).toBe('recording');
    expect(t.proc.kill).not.toHaveBeenCalled();

    await t.advance(COUNTDOWN - 1);
    expect(t.mgr.state(t.sessionId)).toBe('recording');
    expect(t.cleared).toEqual([]);
    await t.advance(1);
    expect(t.cleared).toEqual([`${t.sessionId}:auto-stopped`]);
    expect(t.proc.kill).toHaveBeenCalledTimes(1);
    expect(t.proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(t.repo.finalize).toHaveBeenCalledTimes(1);
    expect(t.mgr.state(t.sessionId)).toBe('idle');
    expect(t.mgr.active()).toEqual([]);
    expect(t.mgr.silenceState()).toBeNull();
    // The user is told why through the ordinary state change.
    expect(SILENCE_AUTO_STOP_REASON).toBe('Stopped automatically after audio went silent');
    expect(t.states.slice(-2)).toEqual([['stopping', undefined], ['idle', SILENCE_AUTO_STOP_REASON]]);
    expect(t.onAutoStop.mock.calls).toEqual([[t.sessionId, PROMPT_AFTER + COUNTDOWN]]);
  });

  it('Continue cancels the countdown, clears the prompt and watches again with a longer window', async () => {
    const t = await recording();
    await t.advance(PROMPT_AFTER);
    expect(t.prompts).toHaveLength(1);
    t.mgr.continueSilence(t.sessionId);
    expect(t.cleared).toEqual([`${t.sessionId}:continued`]);
    expect(t.mgr.silenceState()).toBeNull();
    // A second answer (another window, the menu bar) changes nothing.
    t.mgr.continueSilence(t.sessionId);
    t.mgr.continueSilence('no-such-session');
    expect(t.cleared).toHaveLength(1);

    await t.advance(COUNTDOWN);
    expect(t.proc.kill).not.toHaveBeenCalled();
    expect(t.mgr.state(t.sessionId)).toBe('recording');

    // Still silent: the next prompt waits twice as long, counted from Continue.
    await t.advance(2 * PROMPT_AFTER - COUNTDOWN - 1);
    expect(t.prompts).toHaveLength(1);
    await t.advance(1);
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]).toEqual({ sessionId: t.sessionId, silentForMs: 2 * PROMPT_AFTER, autoStopAtMs: Date.now() + COUNTDOWN });
    // And unanswered, that one does stop the recording.
    await t.advance(COUNTDOWN);
    expect(t.cleared).toEqual([`${t.sessionId}:continued`, `${t.sessionId}:auto-stopped`]);
    expect(t.mgr.state(t.sessionId)).toBe('idle');
  });

  it('caps the window that Continue keeps doubling', async () => {
    const t = await recording({ policy: { promptAfterMs: 20 * 60_000 } });
    await t.advance(20 * 60_000);
    t.mgr.continueSilence(t.sessionId);
    await t.advance(SILENCE_PROMPT_MAX_MS - 1);
    expect(t.prompts).toHaveLength(1);
    await t.advance(1);
    expect(t.prompts).toHaveLength(2);
    t.mgr.continueSilence(t.sessionId);
    await t.advance(SILENCE_PROMPT_MAX_MS);
    expect(t.prompts).toHaveLength(3);
    await t.mgr.stop(t.sessionId);
  });

  it('Stop now during the countdown stops at once and cancels the countdown', async () => {
    const t = await recording();
    await t.advance(PROMPT_AFTER);
    expect(t.mgr.silenceState()).not.toBeNull();
    await t.mgr.stop(t.sessionId);
    expect(t.cleared).toEqual([`${t.sessionId}:stopped`]);
    expect(t.mgr.silenceState()).toBeNull();
    expect(t.mgr.state(t.sessionId)).toBe('idle');
    expect(t.repo.finalize).toHaveBeenCalledTimes(1);

    await t.advance(COUNTDOWN * 2);
    expect(t.proc.kill).toHaveBeenCalledTimes(1);
    expect(t.repo.finalize).toHaveBeenCalledTimes(1);
    expect(t.onAutoStop).not.toHaveBeenCalled();
    expect(t.cleared).toHaveLength(1);
    // A stop the user asked for is not reported as an automatic one.
    expect(t.states.some(([, reason]) => reason === SILENCE_AUTO_STOP_REASON)).toBe(false);
  });

  it('audio above the threshold during the countdown cancels the stop and clears the prompt', async () => {
    const t = await recording();
    await t.advance(PROMPT_AFTER);
    await t.advance(COUNTDOWN / 2);
    // Exactly at the threshold is still silence.
    t.level(SILENCE_THRESHOLD_DB);
    expect(t.cleared).toEqual([]);
    t.level(SILENCE_THRESHOLD_DB + 1, 'mic');
    expect(t.cleared).toEqual([`${t.sessionId}:audio-resumed`]);
    expect(t.mgr.silenceState()).toBeNull();

    await t.advance(COUNTDOWN);
    expect(t.proc.kill).not.toHaveBeenCalled();
    expect(t.mgr.state(t.sessionId)).toBe('recording');

    // Detection is armed again with the ordinary window, from that sound.
    await t.advance(PROMPT_AFTER - COUNTDOWN - 1);
    expect(t.prompts).toHaveLength(1);
    await t.advance(1);
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]!.silentForMs).toBe(PROMPT_AFTER);
    await t.mgr.stop(t.sessionId);
  });

  it('never prompts or stops when stopping on silence is turned off', async () => {
    const t = await recording({ policy: { autoStopOnSilence: false } });
    await t.advance(4 * 60 * 60_000);
    expect(t.prompts).toEqual([]);
    expect(t.cleared).toEqual([]);
    expect(t.proc.kill).not.toHaveBeenCalled();
    expect(t.onAutoStop).not.toHaveBeenCalled();
    expect(t.mgr.state(t.sessionId)).toBe('recording');
    await t.mgr.stop(t.sessionId);
  });

  it('applies a changed setting to a recording that is already running', async () => {
    const t = await recording({ policy: { autoStopOnSilence: false } });
    await t.advance(10 * 60_000);
    expect(t.prompts).toEqual([]);
    // Turned on: the long silence so far is noticed at the next check.
    t.policy.autoStopOnSilence = true;
    await t.advance(SILENCE_POLICY_POLL_MS);
    expect(t.prompts).toHaveLength(1);
    // Turned off while the prompt is showing: the recording is left running.
    t.policy.autoStopOnSilence = false;
    await t.advance(COUNTDOWN);
    expect(t.cleared).toEqual([`${t.sessionId}:continued`]);
    expect(t.proc.kill).not.toHaveBeenCalled();
    expect(t.mgr.state(t.sessionId)).toBe('recording');

    // A shorter window is picked up without restarting the recording.
    t.policy.autoStopOnSilence = true;
    t.level(SILENCE_THRESHOLD_DB + 5);
    t.policy.promptAfterMs = 30_000;
    await t.advance(SILENCE_POLICY_POLL_MS + 30_000);
    expect(t.prompts).toHaveLength(2);
    await t.mgr.stop(t.sessionId);
  });

  it('falls back to the default policy when none, or a broken one, is supplied', async () => {
    const t = await recording({ policy: { promptAfterMs: Number.NaN, countdownMs: -5 } });
    await t.advance(120_000);
    expect(t.prompts).toEqual([{ sessionId: t.sessionId, silentForMs: 120_000, autoStopAtMs: Date.now() + 60_000 }]);
    await t.mgr.stop(t.sessionId);
  });

  it('an audible peak restarts the window; a peak exactly at the threshold does not', async () => {
    const t = await recording();
    await t.advance(PROMPT_AFTER - 1);
    t.level(SILENCE_THRESHOLD_DB + 1);
    await t.advance(PROMPT_AFTER - 1);
    t.level(SILENCE_THRESHOLD_DB);
    expect(t.prompts).toEqual([]);
    await t.advance(1);
    expect(t.prompts).toHaveLength(1);
    await t.mgr.stop(t.sessionId);
  });

  it('a manual stop before any prompt leaves nothing armed', async () => {
    const t = await recording();
    await t.mgr.stop(t.sessionId);
    await t.advance(PROMPT_AFTER + COUNTDOWN);
    expect(t.prompts).toEqual([]);
    expect(t.cleared).toEqual([]);
    expect(t.onAutoStop).not.toHaveBeenCalled();
    expect(t.proc.kill).toHaveBeenCalledTimes(1);
    expect(t.repo.finalize).toHaveBeenCalledTimes(1);
  });

  it('a manual stop racing the automatic one signals and finalizes once', async () => {
    const t = await recording({ autoExitOnTerm: false });
    await t.advance(PROMPT_AFTER + COUNTDOWN);
    expect(t.cleared).toEqual([`${t.sessionId}:auto-stopped`]);
    const manualStop = t.mgr.stop(t.sessionId);
    t.proc.emit('exit', 0);
    await manualStop;
    expect(t.proc.kill).toHaveBeenCalledTimes(1);
    expect(t.repo.finalize).toHaveBeenCalledTimes(1);
    expect(t.mgr.state(t.sessionId)).toBe('idle');
    expect(t.cleared).toHaveLength(1);
  });

  it('keeps Stop available when the automatic stop cannot confirm the recorder exited', async () => {
    const t = await recording({ autoExitOnTerm: false });
    await t.advance(PROMPT_AFTER + COUNTDOWN);
    await t.advance(7000);
    expect(t.mgr.state(t.sessionId)).toBe('stopping');
    expect(t.states.at(-1)).toEqual(['stopping', 'Automatic Stop failed. Retry Stop to confirm recorder exit.']);
    expect(t.repo.finalize).not.toHaveBeenCalled();
    expect(t.onAutoStop).not.toHaveBeenCalled();
    const retry = t.mgr.stop(t.sessionId); t.proc.emit('exit', 0); await retry;
    expect(t.repo.finalize).toHaveBeenCalledTimes(1);
  });

  it('the helper exiting by itself during the countdown clears the prompt and finalizes once', async () => {
    const t = await recording({ autoExitOnTerm: false });
    await t.advance(PROMPT_AFTER);
    t.proc.emit('exit', 0);
    expect(t.cleared).toEqual([`${t.sessionId}:stopped`]);
    await t.advance(COUNTDOWN * 2);
    expect(t.onAutoStop).not.toHaveBeenCalled();
    expect(t.proc.kill).not.toHaveBeenCalled();
    expect(t.repo.finalize).toHaveBeenCalledTimes(1);
    expect(t.mgr.state(t.sessionId)).toBe('idle');
    expect(t.states.at(-1)).toEqual(['idle', 'helper exited unexpectedly (code=0)']);
  });

  it('does not prompt for a throwaway test capture', async () => {
    const t = await recording({ disposable: true });
    await t.advance(PROMPT_AFTER + COUNTDOWN);
    expect(t.prompts).toEqual([]);
    expect(t.proc.kill).not.toHaveBeenCalled();
    await t.mgr.stop(t.sessionId);
  });

  it('an observer that throws cannot interrupt the prompt or the stop', async () => {
    const t = await recording();
    t.mgr.on('silence-prompt', () => { throw new Error('window gone'); });
    t.mgr.on('silence-cleared', () => { throw new Error('window gone'); });
    await t.advance(PROMPT_AFTER + COUNTDOWN);
    expect(t.mgr.state(t.sessionId)).toBe('idle');
    expect(t.repo.finalize).toHaveBeenCalledTimes(1);
  });
});
