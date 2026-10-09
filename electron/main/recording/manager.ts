import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import { captureTitle } from '../../shared/capture-title.js';
import { assertBackupIdle } from '../storage/backup-gate.js';
import path from 'node:path';
import type { RecordingSessionsRepo } from '../storage/recording-sessions-repo.js';

export type RecordingState = 'idle' | 'starting' | 'recording' | 'stopping' | 'error';

export interface StartInput {
  targetPid: number | 'system';
  targetLabel: string;
  mic: boolean;
  groupId?: string | null;
  title?: string;
}

export interface StartResult {
  sessionId: string;
  outputPath: string;
}

export const SILENCE_TIMEOUT_MS = 5 * 60_000;
export const SILENCE_THRESHOLD_DB = -50;
export type RecordingLevelSource = 'mic' | 'system' | 'mixed';
const CAPTURE_TIMING_FIELDS = ['sample_rate', 'channels', 'requested_frames', 'input_frames',
  'converted_frames', 'callback_age_ms', 'holdback_ms', 'mic_late_frames', 'system_late_frames'] as const;
export type CaptureDiagnostic = Partial<Record<typeof CAPTURE_TIMING_FIELDS[number], number>> & {
  stage: 'mic_format' | 'capture_timing' | 'capture_timing_stop';
  source?: 'mic' | 'system';
};

type SpawnFn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;
type LevelListener = (sessionId: string, source: RecordingLevelSource, peakDb: number) => void;
type StateListener = (sessionId: string, state: RecordingState, reason?: string) => void;

interface SessionEntry {
  proc: ChildProcessWithoutNullStreams;
  outputPath: string;
  state: RecordingState;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  stopPromise: Promise<void> | null;
  exited: boolean;
  started: boolean;
  finalized: boolean;
  disposable: boolean;
  input: StartInput;
  startedAt: string;
}

export class RecordingManager {
  private sessions = new Map<string, SessionEntry>();
  private intentRevision = 0;
  get startRevision(): number { return this.intentRevision; }
  cancelPendingStarts(): void { this.intentRevision++; }
  private listeners = {
    level: new Set<(sessionId: string, source: RecordingLevelSource, peakDb: number) => void>(),
    stateChange: new Set<(sessionId: string, state: RecordingState, reason?: string) => void>(),
  };

  constructor(private readonly deps: {
    helperPath: string;
    recordingsDir: string;
    repo: RecordingSessionsRepo;
    spawn?: SpawnFn;
    clock?: () => Date;
    onAutoStop?: (sessionId: string, silenceMs: number) => void;
    onFinalized?: (sessionId: string, outputPath: string) => void;
    onDiagnostic?: (sessionId: string, diagnostic: CaptureDiagnostic) => void;
  }) {}

  async start(input: StartInput, internal: { outputDir?: string; disposable?: boolean; expectedRevision?: number } = {}): Promise<StartResult> {
    assertBackupIdle();
    input = { ...input, title: captureTitle(input.title) };
    // All entry points converge here, AFTER any asynchronous enumeration.
    // Claim synchronously before spawning; a starting/stopping capture also
    // owns the slot. Persisted orphan detection must finish before a new start.
    if (internal.expectedRevision !== undefined && internal.expectedRevision !== this.intentRevision) throw new Error('Recording request was cancelled while sources were loading.');
    if (this.sessions.size > 0 || this.deps.repo.findOpen().length > 0) {
      throw new Error('Already recording or stopping. Finish the active capture first.');
    }
    const now = this.deps.clock?.() ?? new Date();
    // Short random ID — collision-resistant enough for single-user app, easy
    // to copy from logs. (ulid helper isn't present in this project.)
    const sessionId = crypto.randomUUID().slice(0, 8);
    const stamp = now.toISOString()
      .replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const outputPath = path.join(internal.outputDir ?? this.deps.recordingsDir, `recording-${stamp}-${sessionId}.m4a`);

    const args: string[] = [];
    if (input.targetPid === 'system') {
      args.push('--system-audio');
    } else {
      args.push('--pid', String(input.targetPid));
    }
    if (input.mic) args.push('--mic'); else args.push('--no-mic');
    args.push('--out', outputPath);

    // Persist capture intent before spawning. The helper can create its file
    // immediately and the watcher may catalog it before start() resolves.
    if (!internal.disposable) this.deps.repo.insert({
      id: sessionId,
      helperPid: -1,
      targetPid: input.targetPid === 'system' ? null : input.targetPid,
      targetLabel: input.targetLabel,
      outputPath,
      groupId: input.groupId ?? null,
      title: input.title,
    });
    const spawnFn = this.deps.spawn ?? nodeSpawn;
    let proc!: ChildProcessWithoutNullStreams;
    try {
      proc = spawnFn(this.deps.helperPath, args);
    } catch (error) {
      if (!internal.disposable) this.deps.repo.markError(sessionId);
      throw error;
    }
    const entry: SessionEntry = {
      proc,
      outputPath,
      state: 'starting',
      silenceTimer: null,
      stopPromise: null,
      exited: false,
      started: false,
      finalized: false,
      disposable: internal.disposable ?? false,
      input,
      startedAt: now.toISOString(),
    };
    this.sessions.set(sessionId, entry);
    this.transition(sessionId, 'starting');
    try {
      if (!internal.disposable) this.deps.repo.updateHelperPid(sessionId, proc.pid ?? -1);
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
    } catch (error) {
      // Once spawn has succeeded, even setup failures retain the reservation
      // until Stop confirms exit. Never free the slot merely after kill().
      await this.stop(sessionId).catch(() => { /* retain stopping entry */ });
      throw error;
    }

    // Wait for the started event (helper emits {"event":"started"} when CoreAudio is attached).
    let startupFailure: Error | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          startupFailure = new Error('Recorder did not become ready within 15 seconds. Check audio permissions and retry.');
          // Keep the shared slot until exit is confirmed, even after a
          // startup timeout. A retry must not create an overlapping helper.
          this.transition(sessionId, 'stopping');
          void this.stop(sessionId).catch(() => { /* retain retryable controls */ });
          reject(startupFailure);
        }, 15_000);
        const succeed = (): void => { clearTimeout(timer); resolve(); };
        const fail = (error: Error): void => { clearTimeout(timer); reject(error); };
        let buf = '';
        const onChunk = (chunk: string): void => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            this.handleLine(sessionId, line);
            try { if (JSON.parse(line).event === 'started') succeed(); } catch { /* diagnostics may be plain text */ }
          }
        };
        proc.stdout.on('data', onChunk);
        // A missing/non-executable binary emits 'error' and NEVER 'exit' —
        // without this listener the EventEmitter throws uncaught and this
        // promise (and the renderer's Record invoke) hangs forever.
        proc.on('error', (err: Error) => {
          if (!proc.pid) entry.exited = true;
          startupFailure = new Error(`helper failed to spawn: ${err.message}`);
          fail(startupFailure);
        });
        proc.on('exit', (code: number | null) => {
          entry.exited = true;
          if (entry.state === 'stopping' && !entry.stopPromise) {
            this.finalize(sessionId, entry, entry.started && code === 0);
            this.transition(sessionId, 'idle', 'Recorder confirmed exit after the Stop timeout');
            this.sessions.delete(sessionId);
          }
          if (this.sessions.get(sessionId)?.state !== 'recording') {
            startupFailure = new Error(`helper exited before started (code=${code})`);
            fail(startupFailure);
          }
        });
      });
      // A started line and exit/error can arrive in the same event-loop turn.
      // Promise resolution alone must not declare a dead helper recording.
      if (startupFailure) throw startupFailure;
    } catch (e) {
      // A failed start must not leave a live-looking session behind: an open
      // 'recording' row suppresses meeting auto-detect and makes every later
      // meetingnotes://record answer "Already recording" until app restart.
      // An explicit stop owns finalization; don't relabel it as an error or
      // remove its entry while performStop is still using it.
      if (entry.state === 'starting') {
        if (!entry.exited) await this.stop(sessionId).catch(() => { /* preserve unconfirmed helper */ });
        else {
          try { if (!entry.disposable) this.deps.repo.markError(sessionId); } catch { /* best-effort */ }
          this.transition(sessionId, 'error', 'Recorder could not start');
          if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId);
        }
      }
      throw e;
    }
    // A stop can land while we were still 'starting' (URL-scheme stop knows
    // the session id before this method returns). performStop has already
    // finalized the row and killed the helper — resurrecting the session to
    // 'recording' here would report success for a capture that never ran and
    // double-finalize on the helper's exit.
    if (this.sessions.get(sessionId)?.state !== 'starting') {
      throw new Error('recording was stopped before capture started');
    }
    this.transition(sessionId, 'recording');
    entry.started = true;
    this.armSilenceTimer(sessionId);
    // Keep draining stdout for level events for the lifetime of the session.
    // The handler installed above keeps running because we never removed it.
    proc.on('exit', (code: number | null) => {
      const cur = this.sessions.get(sessionId);
      if (cur && cur.state === 'recording') {
        // Helper exited on its own (target app quit / parent watchdog).
        // The reason rides along on the state-change broadcast so the
        // renderer can tell the user WHY their capture ended instead of
        // silently swallowing the banner (#191).
        this.clearSilenceTimer(cur);
        this.transition(sessionId, 'idle', `helper exited unexpectedly (code=${code ?? 'null'})`);
        try { this.finalize(sessionId, cur, code === 0); } catch { /* best-effort */ }
        this.sessions.delete(sessionId);
      }
    });
    return { sessionId, outputPath };
  }

  async stop(sessionId: string): Promise<void> {
    this.cancelPendingStarts();
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no such session: ${sessionId}`);
    if (s.stopPromise) return s.stopPromise;
    s.stopPromise = this.performStop(sessionId, s).catch((error: unknown) => {
      s.stopPromise = null;
      // Keep the slot and controls until actual helper exit, never report a
      // successful stop merely because a signal was sent.
      throw error;
    });
    return s.stopPromise;
  }

  private async performStop(sessionId: string, s: SessionEntry): Promise<void> {
    this.clearSilenceTimer(s);
    this.transition(sessionId, 'stopping');
    if (!s.exited) await new Promise<void>((resolve, reject) => {
      let done = false;
      let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
      let exitTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (hardKillTimer !== null) clearTimeout(hardKillTimer);
        if (exitTimer !== null) clearTimeout(exitTimer);
        s.proc.removeListener('exit', finish);
      };
      const finish = (): void => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      s.proc.on('exit', finish);
      // Hard-kill safety: if SIGTERM doesn't end it in 5s, SIGKILL.
      hardKillTimer = setTimeout(() => {
        try { s.proc.kill('SIGKILL'); } catch { /* already dead */ }
        exitTimer = setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          reject(new Error('Recorder has not confirmed exit. Keep these controls open and retry Stop.'));
        }, 2000);
      }, 5000);
      try { s.proc.kill('SIGTERM'); }
      catch (error) { done = true; cleanup(); reject(error); }
    });
    this.finalize(sessionId, s, s.started);
    if (!s.started || s.disposable) this.transition(sessionId, 'idle', s.started ? undefined : 'Capture did not become ready; recorder has exited');
    if (this.sessions.get(sessionId) === s) this.sessions.delete(sessionId);
  }

  state(sessionId: string): RecordingState {
    return this.sessions.get(sessionId)?.state ?? 'idle';
  }

  recordedOutput(sessionId: string): string | null { return this.deps.repo.findById(sessionId)?.outputPath ?? null; }

  active(): { sessionId: string; state: RecordingState; label: string; startedAt: string; startInput: StartInput; disposable: boolean; outputPath: string }[] {
    return [...this.sessions].map(([sessionId, entry]) => ({ sessionId, state: entry.state, label: entry.input.targetLabel,
      startedAt: entry.startedAt, startInput: entry.input, disposable: entry.disposable, outputPath: entry.outputPath }));
  }

  private finalize(sessionId: string, entry: SessionEntry, eligible: boolean): void {
    if (entry.finalized) return;
    if (!entry.disposable) this.deps.repo.finalize(sessionId);
    entry.finalized = true;
    if (eligible && !entry.disposable) {
      try { this.deps.onFinalized?.(sessionId, entry.outputPath); } catch { /* observer cannot invalidate a completed stop */ }
    }
  }

  on(event: 'level', cb: LevelListener): () => void;
  on(event: 'state-change', cb: StateListener): () => void;
  on(event: 'level' | 'state-change', cb: LevelListener | StateListener): () => void {
    if (event === 'level') this.listeners.level.add(cb as LevelListener);
    else this.listeners.stateChange.add(cb as StateListener);
    return () => { if (event === 'level') this.listeners.level.delete(cb as LevelListener); else this.listeners.stateChange.delete(cb as StateListener); };
  }

  private transition(sessionId: string, state: RecordingState, reason?: string): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.state = state; }
    for (const cb of this.listeners.stateChange) cb(sessionId, state, reason);
  }

  private handleLine(sessionId: string, line: string): void {
    if (!line.trim().startsWith('{')) return;
    let payload: Record<string, unknown> | undefined;
    try { payload = JSON.parse(line); } catch { return; }
    if (payload?.event === 'diag' && (payload.stage === 'mic_format'
      || payload.stage === 'capture_timing' || payload.stage === 'capture_timing_stop')) {
      // Persist only stable numeric capture metadata. Never forward arbitrary
      // helper JSON (paths, device names, meeting content or error strings).
      const diagnostic: CaptureDiagnostic = { stage: payload.stage };
      if (payload.source === 'mic' || payload.source === 'system') diagnostic.source = payload.source;
      for (const key of CAPTURE_TIMING_FIELDS) {
        const value = payload[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) diagnostic[key] = value;
      }
      if (Object.keys(diagnostic).some((key) => key !== 'stage' && key !== 'source')) {
        try { this.deps.onDiagnostic?.(sessionId, diagnostic); } catch { /* logging must not interrupt capture */ }
      }
    }
    if (payload?.event === 'level' && typeof payload.peak_db === 'number') {
      const source: RecordingLevelSource = payload.source === 'mic' || payload.source === 'system'
        || payload.source === 'mixed' ? payload.source : 'mixed';
      if (payload.peak_db > SILENCE_THRESHOLD_DB) this.armSilenceTimer(sessionId);
      for (const cb of this.listeners.level) cb(sessionId, source, payload.peak_db);
    }
  }

  private clearSilenceTimer(entry: SessionEntry): void {
    if (entry.silenceTimer !== null) clearTimeout(entry.silenceTimer);
    entry.silenceTimer = null;
  }

  private armSilenceTimer(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.state !== 'recording') return;
    this.clearSilenceTimer(entry);
    entry.silenceTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (!current || current.state !== 'recording') return;
      current.silenceTimer = null;
      try { this.deps.onAutoStop?.(sessionId, SILENCE_TIMEOUT_MS); } catch { /* observer only */ }
      void this.stop(sessionId).catch(() => this.transition(sessionId, 'stopping', 'Automatic Stop failed. Retry Stop to confirm recorder exit.'));
    }, SILENCE_TIMEOUT_MS);
    // This watchdog should not keep a test process or the app alive by itself.
    (entry.silenceTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }
}
