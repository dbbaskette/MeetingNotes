// Shows when the main-process detector sees a meeting starting — either
// a known meeting URL in a browser tab (#12) or a native meeting app
// (Zoom / Teams / FaceTime / Slack / Discord / WhatsApp) producing
// sustained audio (#78). Offers "Record" (seeds the recording with the
// matching source) and "Dismiss" (suppresses this trigger for the rest
// of the session — 15 min for native apps, until-navigate for browser
// tabs).
import { useEffect, useState } from 'react';
import { api } from '../ipc/client';
import type { RecordingStartInput } from '../App';
import { GroupPicker } from './GroupPicker';
import { useGroupsStore } from '../store/groups';
import { recordingStartFeedback, type RecordingStartFeedback } from '../lib/recording-start-feedback';
import { meetingDetection, titleFromDetected, useDetectedMeeting } from '../lib/meeting-detection';

export type { BrowserDetected, NativeAppDetected, Detected } from '../lib/meeting-detection';

export function MeetingDetectedBanner({
  onStartRecording, groupId, className = 'mb-6',
}: {
  onStartRecording: (info: { sessionId: string; label: string; startInput: RecordingStartInput }) => void;
  groupId?: string | null;
  className?: string;
}): JSX.Element | null {
  // Shared with every other mounted banner: the Library shows it inline, and
  // App shows it above the other views, so detection is visible everywhere.
  const detected = useDetectedMeeting();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<RecordingStartFeedback | null>(null);
  const [saveGroupId, setSaveGroupId] = useState<string | null>(groupId ?? null);
  const groups = useGroupsStore(state => state.groups);
  useEffect(() => { setSaveGroupId(groupId ?? null); }, [groupId]);

  useEffect(() => { setFeedback(null); }, [detected]);

  if (!detected) return null;

  async function record(): Promise<void> {
    if (!detected) return;
    setBusy(true); setFeedback(null);
    try {
      const label = detected.source === 'browser-tab'
        ? `${detected.browserLabel} — ${detected.platform}`
        : detected.appName;
      const targetPid = detected.source === 'browser-tab'
        ? detected.browserPid
        : detected.pid;
      // Name the recording after the meeting when the tab title carries one,
      // instead of leaving a timestamped default to rename later (#297).
      const title = titleFromDetected(detected);
      const input: RecordingStartInput = { targetPid, targetLabel: label, mic: true, groupId: saveGroupId, ...(title ? { title } : {}) };
      const { sessionId } = await api.recording.start(input) as { sessionId: string };
      onStartRecording({ sessionId, label, startInput: input });
      meetingDetection.clear();
    } catch (e) {
      setFeedback(await recordingStartFeedback(e, api.recording));
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
    meetingDetection.clear();
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
    <div role="status" className={`${className} rounded-xl border border-brand-indigo/30 bg-brand-indigo/5 px-4 py-3 flex flex-wrap items-center gap-3`}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">
          {headline}
        </div>
        <div className="text-xs text-ink-muted truncate">
          {subline}
        </div>
        {feedback && <div role={feedback.kind === 'info' ? 'status' : 'alert'} className={`text-xs mt-1 ${feedback.kind === 'info' ? 'text-ink-muted' : 'text-danger'}`}>{feedback.message}</div>}
        {!feedback && (
          <div className="text-[11px] text-ink-muted mt-1">
            {captureHint}
          </div>
        )}
      </div>
      <GroupPicker value={saveGroupId} onSelect={(choice) => setSaveGroupId(choice ?? null)} compact
        triggerLabel={`Save to: ${saveGroupId ? groups.find((group) => group.id === saveGroupId)?.name ?? 'Ungrouped' : 'Ungrouped'}`} />
      <button
        onClick={() => void record()}
        disabled={busy}
        className="btn-primary px-3 py-1.5 text-xs"
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
