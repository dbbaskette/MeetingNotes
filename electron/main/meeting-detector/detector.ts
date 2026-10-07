// electron/main/meeting-detector/detector.ts
//
// Polls the frontmost browsers every ~3s for an active tab URL matching a
// known meeting platform, and emits a `detected` event so the renderer can
// prompt the user to start recording. Strictly additive — doesn't start a
// recording on its own.

import { matchMeeting } from './patterns.js';
import { queryAllBrowsers, type ActiveTab } from './applescript.js';

export interface DetectedMeeting {
  platform: string;
  url: string;
  title: string | null;
  browserPid: number;
  browserLabel: string; // "Google Chrome (54321)"-style label for the recording picker
}

type Listener = (m: DetectedMeeting) => void;

export interface DetectorDeps {
  pollIntervalMs?: number;
  // Return true to silence detection while a recording is active or the
  // modal is already shown.
  isSuppressed?: () => boolean;
  queryBrowsers?: () => Promise<ActiveTab[]>;
}

export class MeetingDetector {
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<Listener>();
  // URLs the user has dismissed this session — don't re-prompt for them
  // until they navigate away and back. Keyed by full URL.
  private dismissed = new Set<string>();
  // The URL we last emitted for. Prevents a steady-state poll loop from
  // firing the same event every tick.
  private emitted = new Set<string>();
  private busy = false;
  private generation = 0;

  constructor(private readonly deps: DetectorDeps = {}) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.pollIntervalMs ?? 3000;
    // Fire once immediately so the first detection doesn't wait a full tick.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
  }

  stop(): void {
    this.generation++;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  onDetected(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dismiss(url: string): void {
    this.dismissed.add(url);
  }

  // Exposed for tests to drive the loop deterministically.
  async tick(): Promise<void> {
    if (this.busy || this.deps.isSuppressed?.()) return;
    this.busy = true;
    const generation = this.generation;
    const query = this.deps.queryBrowsers ?? queryAllBrowsers;
    let tabs: ActiveTab[];
    try {
      tabs = await query();
    } catch {
      return;
    } finally {
      this.busy = false;
    }
    if (generation !== this.generation || this.deps.isSuppressed?.()) return;
    const active = new Set(tabs.filter(t => matchMeeting(t.url)).map(t => t.url));
    for (const url of this.emitted) if (!active.has(url)) this.emitted.delete(url);
    for (const url of this.dismissed) if (!active.has(url)) this.dismissed.delete(url);
    for (const tab of tabs) {
      const platform = matchMeeting(tab.url);
      if (!platform) continue;
      if (this.dismissed.has(tab.url)) continue;
      if (this.emitted.has(tab.url)) continue;
      this.emitted.add(tab.url);
      const detected: DetectedMeeting = {
        platform,
        url: tab.url,
        title: tab.title,
        browserPid: tab.pid,
        browserLabel: prettyBrowserLabel(tab.browser),
      };
      for (const l of this.listeners) {
        try { l(detected); } catch { /* listener isolated from loop */ }
      }
      return; // one event per tick — user handles before we prompt for another
    }
    // No active meeting URL — clear the "lastEmitted" latch so re-opening
    // the same tab later triggers a fresh prompt.
  }
}

function prettyBrowserLabel(k: ActiveTab['browser']): string {
  switch (k) {
    case 'chrome': return 'Google Chrome';
    case 'safari': return 'Safari';
    case 'arc': return 'Arc';
    case 'edge': return 'Microsoft Edge';
    case 'brave': return 'Brave Browser';
  }
}
