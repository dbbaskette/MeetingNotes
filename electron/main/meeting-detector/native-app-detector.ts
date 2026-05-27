// electron/main/meeting-detector/native-app-detector.ts
//
// Polls the AppEnumerator for known native meeting apps (Zoom, Teams,
// FaceTime, Slack, Discord, WhatsApp) and emits a `detected` event when
// one transitions from idle into sustained audio output. Pairs with the
// browser-tab detector in detector.ts — both surface the same
// MeetingDetectedBanner; only the trigger differs. Issue #78.
//
// Trigger model: edge, not level. Once we've fired for `bundle:X` in a
// given audio session, we don't re-fire until the app stops producing
// audio (clearing its session) and starts again. Dismissals add 15-min
// suppression keyed on bundle id so a user who said "no, don't record
// this Zoom" doesn't get re-prompted if Zoom briefly hiccups its audio
// session mid-call.

import type { AppEnumerator } from '../recording/app-enumerator.js';

export interface NativeAppDetected {
  source: 'native-app';
  appName: string;
  bundleId: string;
  pid: number;
}

type Listener = (m: NativeAppDetected) => void;

export const DEFAULT_NATIVE_POLL_INTERVAL_MS = 3000;
export const DEFAULT_NATIVE_SILENCE_MS = 5000;
export const NATIVE_APP_DISMISS_MS = 15 * 60 * 1000;

// Pretty-name fallback when CoreAudio doesn't hand us a display name —
// matches the bundle ids in audio-tap/Sources/.../ProcessList.swift.
export const BUNDLE_PRETTY_NAMES: Record<string, string> = {
  'us.zoom.xos': 'Zoom',
  'com.microsoft.teams2': 'Microsoft Teams',
  'com.microsoft.teams': 'Microsoft Teams',
  'com.apple.FaceTime': 'FaceTime',
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.hnc.Discord': 'Discord',
  'WhatsApp': 'WhatsApp',
  'net.whatsapp.WhatsApp': 'WhatsApp',
};

export interface NativeAppDetectorDeps {
  appEnumerator: AppEnumerator;
  pollIntervalMs?: number;
  /** Required sustained-audio duration before the banner fires. Filters
   *  out notification beeps / 1-2-second app pings. */
  silenceMs?: number;
  /** Returns true while a recording is in progress or the renderer is
   *  busy with the banner — same role as MeetingDetector.isSuppressed. */
  isSuppressed?: () => boolean;
  /** Test-injectable clock. Defaults to Date.now. */
  now?: () => number;
  /** Structured-log sink for diagnostics. Called sparingly (start/stop,
   *  registration, suppression, emit) — never per tick — so the log
   *  doesn't fill up while idle. */
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class NativeAppDetector {
  private timer: NodeJS.Timeout | null = null;
  // bundleId → wall-clock ms when we first saw this app producing audio.
  // Reset when the app stops producing audio.
  private firstSeenAt = new Map<string, number>();
  // bundleIds that have already fired in the current audio session.
  private emitted = new Set<string>();
  // bundleId → wall-clock ms after which the dismissal lapses.
  private dismissedUntil = new Map<string, number>();
  private listeners = new Set<Listener>();

  constructor(private readonly deps: NativeAppDetectorDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.pollIntervalMs ?? DEFAULT_NATIVE_POLL_INTERVAL_MS;
    const silenceMs = this.deps.silenceMs ?? DEFAULT_NATIVE_SILENCE_MS;
    this.deps.log?.('native-detector:start', { pollIntervalMs: interval, silenceMs });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.deps.log?.('native-detector:stop');
  }

  onDetected(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Suppress prompts for this bundle id for the next 15 minutes. The
   *  user clicked "Dismiss" on the banner — don't re-prompt if Zoom's
   *  audio session blips mid-call. */
  dismiss(bundleId: string): void {
    this.dismissedUntil.set(bundleId, this.now() + NATIVE_APP_DISMISS_MS);
  }

  /** Exposed for tests. Run one detection sweep deterministically. */
  async tick(): Promise<void> {
    if (this.deps.isSuppressed?.()) {
      // Log a suppression note only when the state would otherwise have
      // triggered work, so a fully-idle machine doesn't fill the log.
      if (this.firstSeenAt.size > 0) {
        this.deps.log?.('native-detector:tick-suppressed', { reason: 'recording in progress' });
      }
      return;
    }
    const silenceMs = this.deps.silenceMs ?? DEFAULT_NATIVE_SILENCE_MS;
    const now = this.now();

    let sources: Awaited<ReturnType<AppEnumerator['list']>>;
    try {
      sources = await this.deps.appEnumerator.list();
    } catch (e) {
      // Helper failure — same posture as the browser detector, swallow,
      // but leave a breadcrumb so users can see why detection is silent.
      this.deps.log?.('native-detector:enumerate-failed', { err: String(e) });
      return;
    }

    const currentlyActive = new Set<string>();
    for (const s of sources) {
      if (!s.isMeetingApp || !s.isRunningOutput || !s.bundleId) continue;
      currentlyActive.add(s.bundleId);

      const firstSeen = this.firstSeenAt.get(s.bundleId);
      if (firstSeen == null) {
        this.firstSeenAt.set(s.bundleId, now);
        this.deps.log?.('native-detector:registered', {
          bundleId: s.bundleId, name: s.name, silenceMs,
        });
        continue;
      }
      if (this.emitted.has(s.bundleId)) continue;

      const dismissedExp = this.dismissedUntil.get(s.bundleId);
      if (dismissedExp != null) {
        if (now < dismissedExp) continue;
        this.dismissedUntil.delete(s.bundleId);
      }

      if (now - firstSeen < silenceMs) continue;

      this.emitted.add(s.bundleId);
      const detected: NativeAppDetected = {
        source: 'native-app',
        appName: s.name ?? BUNDLE_PRETTY_NAMES[s.bundleId] ?? s.bundleId,
        bundleId: s.bundleId,
        pid: s.pid,
      };
      this.deps.log?.('native-detector:emit', {
        bundleId: s.bundleId, appName: detected.appName, pid: s.pid,
      });
      for (const l of this.listeners) {
        try { l(detected); } catch { /* listener isolated from loop */ }
      }
      return; // one event per tick — let the renderer handle this one before another fires
    }

    // Bundles we'd been watching but that stopped producing audio: drop
    // their firstSeen / emitted state so the next call re-arms the timer.
    // Dismissals persist their full 15-min window regardless.
    for (const bundleId of Array.from(this.firstSeenAt.keys())) {
      if (!currentlyActive.has(bundleId)) {
        this.firstSeenAt.delete(bundleId);
        this.emitted.delete(bundleId);
        this.deps.log?.('native-detector:dropped', { bundleId, reason: 'audio stopped' });
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
