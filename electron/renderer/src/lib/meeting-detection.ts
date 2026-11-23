// electron/renderer/src/lib/meeting-detection.ts
//
// The currently detected meeting, held outside any component (#297). The
// banner used to keep it in its own state and existed only in the Library,
// so a meeting detected while reading a transcript or sitting in Settings
// was never shown, and one shown in the Library vanished on a view switch.
import { useSyncExternalStore } from 'react';
import { api } from '../ipc/client';

export interface BrowserDetected {
  source: 'browser-tab';
  platform: string;
  url: string;
  title: string | null;
  browserPid: number;
  browserLabel: string;
}
export interface NativeAppDetected {
  source: 'native-app';
  appName: string;
  bundleId: string;
  pid: number;
}
export type Detected = BrowserDetected | NativeAppDetected;

type Subscribe = (cb: (detected: Detected) => void) => () => void;

export function createMeetingDetection(subscribe: Subscribe) {
  let detected: Detected | null = null;
  let holders = 0;
  let off: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Detected | null): void => {
    if (next === detected) return;
    detected = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: (): Detected | null => detected,
    /** Forget the detection (recorded, or dismissed by the user). */
    clear: (): void => set(null),
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (holders++ === 0) off = subscribe(set);
      return () => {
        listeners.delete(listener);
        // Keep `detected`: the next reader (another view) shows the same meeting.
        if (--holders === 0) { off?.(); off = null; }
      };
    },
  };
}

export const meetingDetection = createMeetingDetection((cb) => api.meetingDetector.onDetected(cb));

export function useDetectedMeeting(): Detected | null {
  return useSyncExternalStore(meetingDetection.subscribe, meetingDetection.get);
}

/** A capture title from a detected browser tab's title: the page title minus
 *  the product suffix browsers and meeting apps append, or undefined when
 *  nothing meaningful is left (a bare "Google Meet", a URL). */
export function titleFromDetected(detected: Detected): string | undefined {
  if (detected.source !== 'browser-tab' || !detected.title) return undefined;
  const cleaned = detected.title
    .replace(/\s+[-–—|]\s+(Google Meet|Meet|Zoom|Zoom Meeting|Microsoft Teams|Teams|Webex|Whereby|Jitsi Meet|Google Chrome|Chrome|Safari|Arc|Microsoft Edge|Brave)\s*$/i, '')
    .replace(/^(Meet|Zoom|Microsoft Teams)\s+[-–—|]\s+/i, '')
    .trim();
  if (!cleaned || /^https?:\/\//i.test(cleaned)) return undefined;
  if (/^(google meet|meet|zoom|zoom meeting|microsoft teams|teams|webex|whereby|jitsi meet|launch meeting.*)$/i.test(cleaned)) return undefined;
  return cleaned.slice(0, 200);
}
