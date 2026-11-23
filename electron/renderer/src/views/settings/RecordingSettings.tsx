// electron/renderer/src/views/settings/RecordingSettings.tsx
// Recording section: meeting auto-detect and silence, menu bar and shortcut,
// and audio permissions.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../ipc/client';
import { IconLabel } from '../../components/icons';
import { acceleratorFromEvent, formatAccelerator } from '../../lib/shortcut';
import { Field } from './Field';
import type { AudioPerms, PermState, Settings, UpdateSetting } from './types';

export function MeetingDetectionSettings({ s, update }: { s: Settings; update: UpdateSetting }): JSX.Element {
  return (
    <>
      <section className="border-t border-surface-border pt-5">
        <div className="settings-section-title text-ink-muted font-semibold mb-2">Meeting auto-detect</div>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={s.autoDetectMeetings.browserTabs}
            onChange={(e) => update('autoDetectMeetings', { ...s.autoDetectMeetings, browserTabs: e.target.checked })}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-sm text-ink">Watch browser tabs for meeting URLs</div>
            <div className="text-xs text-ink-muted mt-0.5">
              When a tab in Chrome, Safari, Arc, Edge, or Brave opens a known
              meeting URL (Meet, Zoom web, Teams, Whereby, Jitsi, …), a banner
              offers to start recording. Requires granting MeetingNotes
              Automation permission for each browser you use (macOS will
              prompt the first time).
            </div>
            <div className="text-xs text-ink-muted mt-1">
              Note: the recorder captures the whole browser process, so audio
              from other tabs (YouTube, etc.) will bleed in.
            </div>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer mt-3">
          <input
            type="checkbox"
            checked={s.autoDetectMeetings.nativeApps}
            onChange={(e) => update('autoDetectMeetings', { ...s.autoDetectMeetings, nativeApps: e.target.checked })}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-sm text-ink">Watch native meeting apps (Zoom, Teams, FaceTime, Slack, Discord, WhatsApp)</div>
            <div className="text-xs text-ink-muted mt-0.5">
              Fires when one of those apps starts producing audio. A banner
              offers to record the app directly — no need to pick the source
              in the Record menu. Brief notification beeps are filtered out
              by a {Math.round(s.autoDetectMeetings.silenceMs / 1000)}-second
              sustained-audio threshold. Dismissing the banner suppresses
              that app for 15 minutes.
            </div>
          </div>
        </label>
        {/* Per-app auto-record (#78 follow-up). Indented under the native
            toggle because it's a no-op when the parent isn't on. Zoom-only
            in v1; the wiring is parameterized in main so additional apps
            can join later as separate toggles. */}
        <label className={`flex items-start gap-3 cursor-pointer mt-3 ml-6 ${s.autoDetectMeetings.nativeApps ? '' : 'opacity-50'}`}>
          <input
            type="checkbox"
            checked={s.autoRecordZoom}
            disabled={!s.autoDetectMeetings.nativeApps}
            onChange={(e) => update('autoRecordZoom', e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-sm text-ink">Always record Zoom — skip the confirm banner</div>
            <div className="text-xs text-ink-muted mt-0.5">
              When Zoom starts producing audio, MeetingNotes begins
              recording immediately. Other meeting apps still surface the
              confirm-first banner. Requires the native-app detector
              above to be on.
            </div>
          </div>
        </label>
      </section>

      <section className="border-t border-surface-border pt-5 space-y-3">
        <div className="settings-section-title text-ink-muted font-semibold">When audio goes silent</div>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" className="mt-0.5 accent-brand-solid" checked={s.autoStopOnSilence}
            onChange={(e) => void update('autoStopOnSilence', e.target.checked)} />
          <div className="flex-1">
            <div className="text-sm text-ink">Ask before stopping a silent recording</div>
            <div className="text-xs text-ink-muted mt-0.5">
              When the microphone and app audio have both been silent for a while (a call ended and Stop was
              forgotten), MeetingNotes asks whether to stop or continue and shows a countdown. With no answer it
              stops and saves the recording. Turn this off to keep recording until you stop it.
            </div>
          </div>
        </label>
        <div className={`flex flex-wrap gap-4 text-sm ${s.autoStopOnSilence ? '' : 'opacity-50'}`}>
          <label className="flex flex-col gap-1">Ask after
            <select className="input !w-auto" disabled={!s.autoStopOnSilence} value={s.silencePromptAfterS}
              onChange={(e) => void update('silencePromptAfterS', Number(e.target.value))}>
              {[...new Set([60, 120, 300, 600, 900, s.silencePromptAfterS])].sort((a, b) => a - b).map(seconds =>
                <option key={seconds} value={seconds}>{seconds % 60 === 0 ? `${seconds / 60} min of silence` : `${seconds} s of silence`}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">Then stop after
            <select className="input !w-auto" disabled={!s.autoStopOnSilence} value={s.silenceCountdownS}
              onChange={(e) => void update('silenceCountdownS', Number(e.target.value))}>
              {[...new Set([30, 60, 120, 300, s.silenceCountdownS])].sort((a, b) => a - b).map(seconds =>
                <option key={seconds} value={seconds}>{seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`} with no answer</option>)}
            </select>
          </label>
        </div>
      </section>
    </>
  );
}

export function MenuBarShortcutSettings({ s, update }: { s: Settings; update: UpdateSetting }): JSX.Element {
  return (
      <section className="border-t border-surface-border pt-5 space-y-3">
        <div className="settings-section-title text-ink-muted font-semibold">Menu bar and shortcut</div>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={s.showMenuBarIcon ?? true} onChange={e => void update('showMenuBarIcon', e.target.checked)} />
          <span>Show MeetingNotes in the menu bar
            <span className="block text-xs text-ink-muted mt-1">Shows recording time and lets you start or stop a recording without opening the window. MeetingNotes keeps running there when the window is closed.</span>
          </span>
        </label>
        <Field label="Start/stop shortcut (works in any app)">
          <ShortcutRecorder value={s.recordShortcut ?? ''} onChange={(accelerator) => void update('recordShortcut', accelerator)} />
          <div className="text-xs text-ink-muted mt-1">
            Starts recording all system audio with your microphone, or stops the current recording. A combination that cannot be registered, usually because another app uses it, is refused.
          </div>
        </Field>
      </section>
  );
}

export function PermissionsSettings({ perms, recheckPerms }: { perms: AudioPerms | null; recheckPerms: () => Promise<void> }): JSX.Element {
  return (
      <section className="border-t border-surface-border pt-5">
        <div className="flex items-center gap-2 mb-2">
          <div className="settings-section-title text-ink-muted font-semibold flex-1">Permissions</div>
          <button
            onClick={recheckPerms}
            className="text-xs font-semibold text-brand-indigo hover:underline"
          >
            Recheck
          </button>
        </div>
        {perms === null ? (
          <div className="text-sm text-ink-muted">Checking…</div>
        ) : (
          <div className="space-y-1">
            <PermRow label="Microphone" state={perms.mic} action={perms.mic === 'granted' ? null : perms.mic === 'not-determined'
              ? <button type="button" className="btn-secondary" onClick={() => void api.permissions.requestMic().then(recheckPerms, recheckPerms)}>Request access</button>
              : <button type="button" className="btn-secondary" onClick={() => void api.onboarding.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')}>Open System Settings</button>} />
            <PermRow label="System audio" state={perms.audioCapture} action={perms.audioCapture === 'granted' ? null
              : <button type="button" className="btn-secondary" onClick={() => void api.onboarding.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')}>Open System Settings</button>} />
            <div className="text-xs text-ink-muted mt-2">
              Both must be granted for the built-in recorder to capture meeting audio. System audio is only fully confirmed by a recording: use Test recording under Setup &amp; health. After changing a permission in System Settings, choose Recheck.
            </div>
          </div>
        )}
      </section>
  );
}

function PermRow({ label, state, action }: { label: string; state: PermState; action?: ReactNode }): JSX.Element {
  const cls = state === 'granted'
    ? 'text-status-ok'
    : state === 'denied'
      ? 'text-danger'
      : 'text-ink-muted';
  const txt = state === 'granted' ? <IconLabel icon="check">Granted</IconLabel>
    : state === 'denied' ? <IconLabel icon="x">Denied</IconLabel>
      : state === 'not-determined' ? 'Not granted yet'
        : 'Unknown';
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="flex-1">{label}</span>
      <span className={`font-semibold ${cls}`}>{txt}</span>
      {action}
    </div>
  );
}

/** Records a global shortcut by pressing it, instead of hand-typing an
 *  Electron accelerator string (#299). Click Record, press the combination;
 *  Escape cancels. Clear removes the shortcut. */
function ShortcutRecorder({ value, onChange }: { value: string; onChange: (accelerator: string) => void }): JSX.Element {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState('');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" aria-label={recording ? 'Press the key combination to use' : value ? `Shortcut ${value}. Record a different one` : 'Record a shortcut'}
        onClick={() => { setRecording(true); setHint(''); }}
        onBlur={() => setRecording(false)}
        onKeyDown={(event) => {
          if (!recording) return;
          // Tab must keep moving focus so the field is never a trap.
          if (event.key === 'Tab') { setRecording(false); return; }
          event.preventDefault(); event.stopPropagation();
          if (event.key === 'Escape') { setRecording(false); setHint(''); return; }
          const accelerator = acceleratorFromEvent(event);
          if (accelerator) { setRecording(false); setHint(''); onChange(accelerator); }
          else if (!['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) setHint('Add Control, Option or Command to the key.');
        }}
        className={`input !w-auto min-w-[12rem] text-left font-mono text-xs ${recording ? 'ring-2 ring-brand-indigo/50 border-brand-indigo' : ''}`}>
        {recording ? 'Press a key combination…' : value ? `${formatAccelerator(value)}  (${value})` : 'None'}
      </button>
      {!recording && <button type="button" className="btn-secondary" onClick={() => { setRecording(true); setHint(''); }}>{value ? 'Change' : 'Record shortcut'}</button>}
      {value && !recording && <button type="button" className="btn-secondary" onClick={() => onChange('')}>Clear</button>}
      <span role="status" aria-live="polite" className="text-xs text-ink-muted">{recording ? (hint || 'Esc cancels.') : ''}</span>
    </div>
  );
}
