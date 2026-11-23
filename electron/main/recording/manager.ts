import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import { captureTitle } from '../../shared/capture-title.js';
import { assertBackupIdle } from '../storage/backup-gate.js';
import path from 'node:path';
import type { RecordingSessionsRepo } from '../storage/recording-sessions-repo.js';
import type { CalendarEventSnapshot } from '../calendar/service.js';

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

/** A level at or below this peak counts as silence. */
export const SILENCE_THRESHOLD_DB = -50;
/** How silence is handled (#305). Read again each time detection is armed or
 *  a timer fires, so a Settings change applies to a recording in progress. */
export interface SilencePolicy {
  /** False = never prompt and never stop a recording for silence. */
  autoStopOnSilence: boolean;
  /** Continuous silence before the stop-or-continue prompt. */
  promptAfterMs: number;
  /** How long the prompt waits for an answer before stopping. */
  countdownMs: number;
}
export const DEFAULT_SILENCE_POLICY: SilencePolicy = { autoStopOnSilence: true, promptAfterMs: 120_000, countdownMs: 60_000 };
/** Each Continue doubles the next prompt window, up to this. */
export const SILENCE_PROMPT_MAX_MS = 30 * 60_000;
/** Longest wait before the policy is read again, so a changed setting reaches
 *  a recording that is already running. */
export const SILENCE_POLICY_POLL_MS = 15_000;
/** The reason an automatic stop carries on its `idle` state change. */
export const SILENCE_AUTO_STOP_REASON = 'Stopped automatically after audio went silent';
/** A pending stop-or-continue prompt. `autoStopAtMs` is epoch milliseconds. */
export interface SilencePrompt { sessionId: string; silentForMs: number; autoStopAtMs: number }
export type SilenceClearReason = 'audio-resumed' | 'continued' | 'stopped' | 'auto-stopped';

export type RecordingLevelSource = 'mic' | 'system' | 'mixed';
const CAPTURE_TIMING_FIELDS = ['sample_rate', 'channels', 'requested_frames', 'input_frames',
  'converted_frames', 'callback_age_ms', 'holdback_ms', 'mic_late_frames', 'system_late_frames',
  'attempt', 'stalled_ms',
  // App-audio tap format, as the tap, its aggregate device and the stream report it.
  'tap_sr', 'agg_sr', 'sr', 'ch', 'bits', 'bytes_per_frame', 'fmt_flags',
  // Whether the aggregate device is running, and its stream format once started.
  'device_is_running', 'stream_sr', 'stream_ch',
  // IOProc callback counts, and the shape of the buffers it was handed.
  'ioproc_fires', 'ioproc_fires_total', 'fire', 'abl_count', 'buf0_bytes', 'buf0_chans', 'frames',
  // Frames produced by the app-audio converter.
  'out_frames'] as const;
const CAPTURE_DIAGNOSTIC_STAGES = ['mic_format', 'capture_timing', 'capture_timing_stop',
  // The app-audio tap stopped delivering and was rebuilt / is delivering again.
  'tap_stalled', 'tap_recovered',
  // App-audio tap setup, its first callbacks and its final callback count.
  'tap_format', 'after_start', 'ioproc', 'post_conv', 'stop'] as const;
/** The helper reports these with an error string or nothing at all. The stage
 *  name alone is kept: it says the conversion failed, and nothing else. */
const CAPTURE_MARKER_STAGES = ['pcmbuf_nil', 'conv_err'] as const;
/** The helper's once-a-second callback count has no stage of its own. */
const TAP_HEARTBEAT_STAGE = 'tap_heartbeat';
/** Stages the helper repeats for the whole recording, with how many of the
 *  first reports are kept before they are thinned to one per interval. */
const REPEATING_DIAGNOSTIC_BURST: Partial<Record<CaptureDiagnostic['stage'], number>> = { ioproc: 3, [TAP_HEARTBEAT_STAGE]: 1 };
export const REPEATING_DIAGNOSTIC_INTERVAL_MS = 60_000;
export type CaptureDiagnostic = Partial<Record<typeof CAPTURE_TIMING_FIELDS[number], number>> & {
  stage: typeof CAPTURE_DIAGNOSTIC_STAGES[number] | typeof CAPTURE_MARKER_STAGES[number] | typeof TAP_HEARTBEAT_STAGE;
  source?: 'mic' | 'system';
};

type SpawnFn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;
type LevelListener = (sessionId: string, source: RecordingLevelSource, peakDb: number) => void;
type StateListener = (sessionId: string, state: RecordingState, reason?: string) => void;
type SilencePromptListener = (prompt: SilencePrompt) => void;
type SilenceClearedListener = (sessionId: string, reason: SilenceClearReason) => void;
type Timer = ReturnType<typeof setTimeout>;

/** Silence handling for one recording. With `prompt` null it is detecting:
 *  `timer` wakes to compare the quiet time against the window. With `prompt`
 *  set it is counting down: `timer` is the automatic stop. */
interface SilenceWatch {
  timer: Timer | null;
  /** Epoch ms of the last level above the threshold (or when detection began). */
  lastAudibleAt: number;
  /** Times the user chose Continue; each one doubles the next window. */
  continues: number;
  prompt: SilencePrompt | null;
}

interface SessionEntry {
  proc: ChildProcessWithoutNullStreams;
  outputPath: string;
  state: RecordingState;
  silence: SilenceWatch;
  /** Last report kept for each repeating diagnostic stage. */
  repeating: Map<string, { count: number; at: number; running: number | undefined }>;
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
    silencePrompt: new Set<SilencePromptListener>(),
    silenceCleared: new Set<SilenceClearedListener>(),
  };

  constructor(private readonly deps: {
    helperPath: string;
    recordingsDir: string;
    repo: RecordingSessionsRepo;
    spawn?: SpawnFn;
    clock?: () => Date;
    /** How silence is handled; read each time it is needed. Omitted = defaults. */
    getSilencePolicy?: () => SilencePolicy;
    /** Called once a recording has been stopped and finalized for silence. */
    onAutoStop?: (sessionId: string, silentForMs: number) => void;
    onFinalized?: (sessionId: string, outputPath: string) => void;
    onDiagnostic?: (sessionId: string, diagnostic: CaptureDiagnostic) => void;
    /** Calendar-aware recording (#253): the event happening at `now`, or
     *  null. Expected never to throw and to call nothing when the feature
     *  is off (CalendarService.eventAt). */
    calendarEventAt?: (now: Date) => Promise<CalendarEventSnapshot | null>;
  }) {}

  async start(input: StartInput, internal: { outputDir?: string; disposable?: boolean; expectedRevision?: number } = {}): Promise<StartResult> {
    assertBackupIdle();
    input = { ...input, title: captureTitle(input.title) };
    // Calendar-aware recording (#253). Looked up before the slot is claimed:
    // the check-and-claim below stays synchronous. An explicit title (from
    // the UI or the URL scheme's `title=`) always wins over the event title.
    // Capture tests are disposable and never consult the calendar.
    let calendarEvent: CalendarEventSnapshot | null = null;
    if (!internal.disposable && this.deps.calendarEventAt && this.sessions.size === 0) {
      calendarEvent = await this.deps.calendarEventAt(this.deps.clock?.() ?? new Date()).catch(() => null);
      if (!input.title && calendarEvent?.title) input = { ...input, title: calendarEvent.title };
    }
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
      calendarEvent,
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
      silence: { timer: null, lastAudibleAt: 0, continues: 0, prompt: null },
      repeating: new Map(),
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
            if (this.handleLine(sessionId, line)) succeed();
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
    // A test capture is short and has no live row to answer a prompt.
    if (!entry.disposable) this.watchForSilence(sessionId, entry);
    // Keep draining stdout for level events for the lifetime of the session.
    // The handler installed above keeps running because we never removed it.
    proc.on('exit', (code: number | null) => {
      const cur = this.sessions.get(sessionId);
      if (cur && cur.state === 'recording') {
        // Helper exited on its own (target app quit / parent watchdog).
        // The reason rides along on the state-change broadcast so the
        // renderer can tell the user WHY their capture ended instead of
        // silently swallowing the banner (#191).
        this.endSilenceWatch(sessionId, cur, 'stopped');
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
    this.endSilenceWatch(sessionId, s, 'stopped');
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
  on(event: 'silence-prompt', cb: SilencePromptListener): () => void;
  on(event: 'silence-cleared', cb: SilenceClearedListener): () => void;
  on(event: 'level' | 'state-change' | 'silence-prompt' | 'silence-cleared',
    cb: LevelListener | StateListener | SilencePromptListener | SilenceClearedListener): () => void {
    const set = (event === 'level' ? this.listeners.level
      : event === 'state-change' ? this.listeners.stateChange
        : event === 'silence-prompt' ? this.listeners.silencePrompt
          : this.listeners.silenceCleared) as Set<typeof cb>;
    set.add(cb);
    return () => { set.delete(cb); };
  }

  /** The stop-or-continue prompt that is waiting for an answer, if any. */
  silenceState(): SilencePrompt | null {
    for (const entry of this.sessions.values()) if (entry.silence.prompt) return { ...entry.silence.prompt };
    return null;
  }

  /** Answer the prompt with Continue: the recording carries on and the next
   *  prompt waits twice as long. Does nothing when no prompt is pending, so a
   *  second answer from another window or the menu bar is harmless. */
  continueSilence(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry?.silence.prompt || entry.state !== 'recording') return;
    entry.silence.continues++;
    this.clearSilencePrompt(sessionId, entry, 'continued');
    this.watchForSilence(sessionId, entry);
  }

  private transition(sessionId: string, state: RecordingState, reason?: string): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.state = state; }
    for (const cb of this.listeners.stateChange) cb(sessionId, state, reason);
  }

  private handleLine(sessionId: string, line: string): boolean {
    if (!line.trim().startsWith('{')) return false;
    let payload: Record<string, unknown> | undefined;
    try { payload = JSON.parse(line); } catch { return false; }
    if (payload?.event === 'started') return true;
    const stage = CAPTURE_DIAGNOSTIC_STAGES.find((known) => known === payload?.stage);
    if (payload?.event === 'diag' && stage) {
      // Persist only stable numeric capture metadata. Never forward arbitrary
      // helper JSON (paths, device names, meeting content or error strings).
      const diagnostic: CaptureDiagnostic = { stage };
      if (payload.source === 'mic' || payload.source === 'system') diagnostic.source = payload.source;
      for (const key of CAPTURE_TIMING_FIELDS) {
        const value = payload[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) diagnostic[key] = value;
      }
      if (Object.keys(diagnostic).some((key) => key !== 'stage' && key !== 'source')) this.reportDiagnostic(sessionId, diagnostic);
    } else if (payload?.event === 'diag') {
      const marker = CAPTURE_MARKER_STAGES.find((known) => known === payload?.stage);
      if (marker) this.reportDiagnostic(sessionId, { stage: marker });
      else if (payload.stage === undefined) {
        // The once-a-second tap heartbeat: callback count and device state.
        const heartbeat: CaptureDiagnostic = { stage: TAP_HEARTBEAT_STAGE };
        for (const key of ['ioproc_fires', 'device_is_running'] as const) {
          const value = payload[key];
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) heartbeat[key] = value;
        }
        if (heartbeat.ioproc_fires !== undefined) this.reportDiagnostic(sessionId, heartbeat);
      }
    }
    if (payload?.event === 'level' && typeof payload.peak_db === 'number') {
      const source: RecordingLevelSource = payload.source === 'mic' || payload.source === 'system'
        || payload.source === 'mixed' ? payload.source : 'mixed';
      if (payload.peak_db > SILENCE_THRESHOLD_DB) this.heardAudio(sessionId);
      for (const cb of this.listeners.level) cb(sessionId, source, payload.peak_db);
    }
    return false;
  }

  /** Hands a diagnostic to the observer. Stages the helper repeats all
   *  recording long are thinned: the first few, then one per interval, plus
   *  any report where the device's running state changed. */
  private reportDiagnostic(sessionId: string, diagnostic: CaptureDiagnostic): void {
    const burst = REPEATING_DIAGNOSTIC_BURST[diagnostic.stage];
    const entry = this.sessions.get(sessionId);
    if (burst !== undefined && entry) {
      const now = Date.now();
      const seen = entry.repeating.get(diagnostic.stage) ?? { count: 0, at: 0, running: undefined };
      const runningChanged = seen.count > 0 && diagnostic.device_is_running !== seen.running;
      if (seen.count >= burst && !runningChanged && now - seen.at < REPEATING_DIAGNOSTIC_INTERVAL_MS) return;
      entry.repeating.set(diagnostic.stage, { count: seen.count + 1, at: now, running: diagnostic.device_is_running });
    }
    try { this.deps.onDiagnostic?.(sessionId, diagnostic); } catch { /* logging must not interrupt capture */ }
  }

  // --- Silence: prompt, then stop if nobody answers (#305) -----------------

  private silencePolicy(): SilencePolicy {
    let policy: SilencePolicy | undefined;
    try { policy = this.deps.getSilencePolicy?.(); } catch { /* fall back to defaults */ }
    const ms = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
    return {
      autoStopOnSilence: typeof policy?.autoStopOnSilence === 'boolean' ? policy.autoStopOnSilence : DEFAULT_SILENCE_POLICY.autoStopOnSilence,
      promptAfterMs: ms(policy?.promptAfterMs, DEFAULT_SILENCE_POLICY.promptAfterMs),
      countdownMs: ms(policy?.countdownMs, DEFAULT_SILENCE_POLICY.countdownMs),
    };
  }

  private setSilenceTimer(entry: SessionEntry, delayMs: number, run: () => void): void {
    if (entry.silence.timer !== null) clearTimeout(entry.silence.timer);
    entry.silence.timer = setTimeout(run, delayMs);
    // Silence handling should not keep a test process or the app alive by itself.
    (entry.silence.timer as Timer & { unref?: () => void }).unref?.();
  }

  /** Phase 1: start (or restart) counting silence from now. */
  private watchForSilence(sessionId: string, entry: SessionEntry): void {
    entry.silence.lastAudibleAt = Date.now();
    this.scheduleSilenceCheck(sessionId, entry);
  }

  /** Wake when the quiet time could reach the window, or sooner to pick up a
   *  changed policy. Level events only move `lastAudibleAt`; they never touch
   *  the timer, so a loud meeting costs no timer churn. */
  private scheduleSilenceCheck(sessionId: string, entry: SessionEntry): void {
    const policy = this.silencePolicy();
    const windowMs = Math.min(Math.max(policy.promptAfterMs, SILENCE_PROMPT_MAX_MS),
      policy.promptAfterMs * 2 ** Math.min(entry.silence.continues, 16));
    const silentForMs = Math.max(0, Date.now() - entry.silence.lastAudibleAt);
    if (policy.autoStopOnSilence && silentForMs >= windowMs) {
      this.promptForSilence(sessionId, entry, silentForMs, policy.countdownMs);
      return;
    }
    const wait = policy.autoStopOnSilence ? Math.min(windowMs - silentForMs, SILENCE_POLICY_POLL_MS) : SILENCE_POLICY_POLL_MS;
    this.setSilenceTimer(entry, wait, () => {
      const current = this.sessions.get(sessionId);
      if (current !== entry || entry.state !== 'recording' || entry.silence.prompt) return;
      entry.silence.timer = null;
      this.scheduleSilenceCheck(sessionId, entry);
    });
  }

  /** Phase 2: tell the user, keep recording, and stop when the countdown ends. */
  private promptForSilence(sessionId: string, entry: SessionEntry, silentForMs: number, countdownMs: number): void {
    const prompt: SilencePrompt = { sessionId, silentForMs, autoStopAtMs: Date.now() + countdownMs };
    entry.silence.prompt = prompt;
    this.setSilenceTimer(entry, countdownMs, () => {
      if (this.sessions.get(sessionId) !== entry || entry.state !== 'recording' || entry.silence.prompt !== prompt) return;
      entry.silence.timer = null;
      // Turned off while the prompt was showing: leave the recording running.
      if (!this.silencePolicy().autoStopOnSilence) {
        this.clearSilencePrompt(sessionId, entry, 'continued');
        this.watchForSilence(sessionId, entry);
        return;
      }
      this.autoStop(sessionId, entry, Math.max(0, Date.now() - entry.silence.lastAudibleAt));
    });
    for (const cb of this.listeners.silencePrompt) {
      try { cb({ ...prompt }); } catch { /* an observer cannot interrupt capture */ }
    }
  }

  private autoStop(sessionId: string, entry: SessionEntry, silentForMs: number): void {
    this.clearSilencePrompt(sessionId, entry, 'auto-stopped');
    void this.stop(sessionId).then(() => {
      // An ordinary Stop is announced by whoever asked for it. Nobody asked
      // for this one, so the reason rides on the state change like any other
      // capture that ended by itself.
      this.transition(sessionId, 'idle', SILENCE_AUTO_STOP_REASON);
      try { this.deps.onAutoStop?.(sessionId, silentForMs); } catch { /* observer only */ }
    }, () => this.transition(sessionId, 'stopping', 'Automatic Stop failed. Retry Stop to confirm recorder exit.'));
  }

  /** A level above the threshold arrived. */
  private heardAudio(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.state !== 'recording' || entry.disposable) return;
    entry.silence.lastAudibleAt = Date.now();
    if (!entry.silence.prompt) return;
    this.clearSilencePrompt(sessionId, entry, 'audio-resumed');
    this.scheduleSilenceCheck(sessionId, entry);
  }

  /** Withdraw a pending prompt and its countdown, and say why. */
  private clearSilencePrompt(sessionId: string, entry: SessionEntry, reason: SilenceClearReason): void {
    if (!entry.silence.prompt) return;
    entry.silence.prompt = null;
    if (entry.silence.timer !== null) clearTimeout(entry.silence.timer);
    entry.silence.timer = null;
    for (const cb of this.listeners.silenceCleared) {
      try { cb(sessionId, reason); } catch { /* an observer cannot interrupt capture */ }
    }
  }

  /** The recording is ending: no more detection, and no prompt left behind. */
  private endSilenceWatch(sessionId: string, entry: SessionEntry, reason: SilenceClearReason): void {
    this.clearSilencePrompt(sessionId, entry, reason);
    if (entry.silence.timer !== null) clearTimeout(entry.silence.timer);
    entry.silence.timer = null;
  }
}
