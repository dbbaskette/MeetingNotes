// Shows when the main-process detector sees a known meeting URL in a browser
// tab. Offers "Record" (seeds the recording with the browser PID) and
// "Dismiss" (suppresses this URL for the rest of the session).
import { useEffect, useState } from 'react';
import { api } from '../ipc/client';

export interface Detected {
  platform: string;
  url: string;
  title: string | null;
  browserPid: number;
  browserLabel: string;
}

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
      const label = `${detected.browserLabel} — ${detected.platform}`;
      const { sessionId } = await api.recording.start({
        targetPid: detected.browserPid, targetLabel: label, mic: true,
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
    if (detected) void api.meetingDetector.dismiss(detected.url);
    setDetected(null);
  }

  return (
    <div className="mb-6 rounded-xl border border-brand-indigo/30 bg-brand-indigo/5 px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">
          {detected.platform} detected in {detected.browserLabel}
        </div>
        <div className="text-xs text-ink-muted truncate">
          {detected.title ?? detected.url}
        </div>
        {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
        {!error && (
          <div className="text-[11px] text-ink-muted mt-1">
            Other tabs in {detected.browserLabel} will also be captured —
            close or mute them first if you don&apos;t want them in the recording.
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
