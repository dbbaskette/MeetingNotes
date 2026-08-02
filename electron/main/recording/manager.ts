import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import type { RecordingSessionsRepo } from '../storage/recording-sessions-repo.js';

export type RecordingState = 'idle' | 'starting' | 'recording' | 'stopping' | 'error';

export interface StartInput {
  targetPid: number | 'system';
  targetLabel: string;
  mic: boolean;
}

export interface StartResult {
  sessionId: string;
  outputPath: string;
}

export const SILENCE_TIMEOUT_MS = 5 * 60_000;
export const SILENCE_THRESHOLD_DB = -50;

type SpawnFn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams | any;

interface SessionEntry {
  proc: any;
  outputPath: string;
  state: RecordingState;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  stopPromise: Promise<void> | null;
}

export class RecordingManager {
  private sessions = new Map<string, SessionEntry>();
  private listeners = {
    level: new Set<(sessionId: string, peakDb: number) => void>(),
    stateChange: new Set<(sessionId: string, state: RecordingState) => void>(),
  };

  constructor(private readonly deps: {
    helperPath: string;
    recordingsDir: string;
    repo: RecordingSessionsRepo;
    spawn?: SpawnFn;
    clock?: () => Date;
    onAutoStop?: (sessionId: string, silenceMs: number) => void;
  }) {}

  async start(input: StartInput): Promise<StartResult> {
    const now = this.deps.clock?.() ?? new Date();
    // Short random ID — collision-resistant enough for single-user app, easy
    // to copy from logs. (ulid helper isn't present in this project.)
    const sessionId = crypto.randomUUID().slice(0, 8);
    const stamp = now.toISOString()
      .replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const outputPath = path.join(this.deps.recordingsDir, `recording-${stamp}-${sessionId}.m4a`);

    const args: string[] = [];
    if (input.targetPid === 'system') {
      args.push('--system-audio');
    } else {
      args.push('--pid', String(input.targetPid));
    }
    if (input.mic) args.push('--mic'); else args.push('--no-mic');
    args.push('--out', outputPath);

    const spawnFn = this.deps.spawn ?? nodeSpawn;
    const proc = spawnFn(this.deps.helperPath, args);
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    const entry: SessionEntry = {
      proc,
      outputPath,
      state: 'starting',
      silenceTimer: null,
      stopPromise: null,
    };
    this.sessions.set(sessionId, entry);
    this.deps.repo.insert({
      id: sessionId,
      helperPid: proc.pid ?? -1,
      targetPid: input.targetPid === 'system' ? null : input.targetPid,
      targetLabel: input.targetLabel,
      outputPath,
    });

    // Wait for the started event (helper emits {"event":"started"} when CoreAudio is attached).
    try {
      await new Promise<void>((resolve, reject) => {
        let buf = '';
        const onChunk = (chunk: string): void => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            this.handleLine(sessionId, line);
            if (line.includes('"event":"started"')) resolve();
          }
        };
        proc.stdout.on('data', onChunk);
        // A missing/non-executable binary emits 'error' and NEVER 'exit' —
        // without this listener the EventEmitter throws uncaught and this
        // promise (and the renderer's Record invoke) hangs forever.
        proc.on('error', (err: Error) => {
          reject(new Error(`helper failed to spawn: ${err.message}`));
        });
        proc.on('exit', (code: number | null) => {
          if (this.sessions.get(sessionId)?.state !== 'recording') {
            reject(new Error(`helper exited before started (code=${code})`));
          }
        });
      });
    } catch (e) {
      // A failed start must not leave a live-looking session behind: an open
      // 'recording' row suppresses meeting auto-detect and makes every later
      // meetingnotes://record answer "Already recording" until app restart.
      try { this.deps.repo.markError(sessionId); } catch { /* best-effort */ }
      this.sessions.delete(sessionId);
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
    this.armSilenceTimer(sessionId);
    // Keep draining stdout for level events for the lifetime of the session.
    // The handler installed above keeps running because we never removed it.
    proc.on('exit', () => {
      const cur = this.sessions.get(sessionId);
      if (cur && cur.state === 'recording') {
        // Helper exited on its own (target app quit / parent watchdog).
        this.clearSilenceTimer(cur);
        this.transition(sessionId, 'idle');
        try { this.deps.repo.finalize(sessionId); } catch { /* best-effort */ }
        this.sessions.delete(sessionId);
      }
    });
    return { sessionId, outputPath };
  }

  async stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no such session: ${sessionId}`);
    if (s.stopPromise) return s.stopPromise;
    s.stopPromise = this.performStop(sessionId, s);
    return s.stopPromise;
  }

  private async performStop(sessionId: string, s: SessionEntry): Promise<void> {
    this.clearSilenceTimer(s);
    this.transition(sessionId, 'stopping');
    await new Promise<void>((resolve) => {
      let done = false;
      let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (hardKillTimer !== null) clearTimeout(hardKillTimer);
        resolve();
      };
      s.proc.on('exit', finish);
      // Hard-kill safety: if SIGTERM doesn't end it in 5s, SIGKILL.
      hardKillTimer = setTimeout(() => {
        try { s.proc.kill('SIGKILL'); } catch { /* already dead */ }
        finish();
      }, 5000);
      s.proc.kill('SIGTERM');
    });
    this.deps.repo.finalize(sessionId);
    if (this.sessions.get(sessionId) === s) this.sessions.delete(sessionId);
  }

  state(sessionId: string): RecordingState {
    return this.sessions.get(sessionId)?.state ?? 'idle';
  }

  on(event: 'level', cb: (sessionId: string, peakDb: number) => void): void;
  on(event: 'state-change', cb: (sessionId: string, state: RecordingState) => void): void;
  on(event: 'level' | 'state-change', cb: any): void {
    if (event === 'level') this.listeners.level.add(cb);
    else this.listeners.stateChange.add(cb);
  }

  private transition(sessionId: string, state: RecordingState): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.state = state; }
    for (const cb of this.listeners.stateChange) cb(sessionId, state);
  }

  private handleLine(sessionId: string, line: string): void {
    if (!line.trim().startsWith('{')) return;
    let payload: { event?: string; peak_db?: number } | undefined;
    try { payload = JSON.parse(line); } catch { return; }
    if (payload?.event === 'level' && typeof payload.peak_db === 'number') {
      if (payload.peak_db > SILENCE_THRESHOLD_DB) this.armSilenceTimer(sessionId);
      for (const cb of this.listeners.level) cb(sessionId, payload.peak_db);
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
      void this.stop(sessionId).catch(() => this.transition(sessionId, 'error'));
    }, SILENCE_TIMEOUT_MS);
    // This watchdog should not keep a test process or the app alive by itself.
    (entry.silenceTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }
}
