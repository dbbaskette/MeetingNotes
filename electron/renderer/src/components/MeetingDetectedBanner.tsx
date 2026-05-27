// Shows when the main-process detector sees a meeting starting — either
// a known meeting URL in a browser tab (#12) or a native meeting app
// (Zoom / Teams / FaceTime / Slack / Discord / WhatsApp) producing
// sustained audio (#78). Offers "Record" (seeds the recording with the
// matching source) and "Dismiss" (suppresses this trigger for the rest
// of the session — 15 min for native apps, until-navigate for browser
// tabs).
import { useEffect, useState } from 'react';
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

export function MeetingDetectedBanner({
  onStartRecording,
}: {
  onStartRecording: (info: { sessionId: string; label: string }) => void;
}): JSX.Element | null {
  const [detected, setDetected] = useState<Detected | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = api.meetingDetector.onDetected((m) => {
      setDetected(m);
      setError(null);
    });
    return () => { unsub(); };
  }, []);

  if (!detected) return null;

  async function record(): Promise<void> {
    if (!detected) return;
    setBusy(true); setError(null);
    try {
      const label = detected.source === 'browser-tab'
        ? `${detected.browserLabel} — ${detected.platform}`
        : detected.appName;
      const targetPid = detected.source === 'browser-tab'
        ? detected.browserPid
        : detected.pid;
      const { sessionId } = await api.recording.start({
        targetPid, targetLabel: label, mic: true,
      }) as { sessionId: string };
      onStartRecording({ sessionId, label });
      setDetected(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function dismiss(): void {
    if (detected) {
      if (detected.source === 'browser-tab') {
        void api.meetingDetector.dismiss({ kind: 'browser-tab', url: detected.url });
      } else {
        void api.meetingDetector.dismiss({ kind: 'native-app', bundleId: detected.bundleId });
      }
    }
    setDetected(null);
  }

  const headline = detected.source === 'browser-tab'
    ? `${detected.platform} detected in ${detected.browserLabel}`
    : `${detected.appName} is in a call`;
  const subline = detected.source === 'browser-tab'
    ? (detected.title ?? detected.url)
    : 'Started producing audio just now — record this meeting?';
  const captureHint = detected.source === 'browser-tab'
    ? `Other tabs in ${detected.browserLabel} will also be captured — close or mute them first if you don't want them in the recording.`
    : `MeetingNotes will record only ${detected.appName}'s audio plus your mic.`;

  return (
    <div className="mb-6 rounded-xl border border-brand-indigo/30 bg-brand-indigo/5 px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">
          {headline}
        </div>
        <div className="text-xs text-ink-muted truncate">
          {subline}
        </div>
        {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
        {!error && (
          <div className="text-[11px] text-ink-muted mt-1">
            {captureHint}
          </div>
        )}
      </div>
      <button
        onClick={() => void record()}
        disabled={busy}
        className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white bg-gradient-to-br from-brand-indigo to-brand-violet disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Record'}
      </button>
      <button
        onClick={dismiss}
        className="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-muted hover:text-ink"
      >
        Dismiss
      </button>
    </div>
  );
}
