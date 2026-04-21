// electron/renderer/src/views/SettingsView.tsx
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../ipc/client';

interface Settings {
  lmStudioUrl: string;
  sttUrl: string;
  sttModel: string;
  llmModel: string;
  audioHijackSessionName: string;
  libraryPath: string;
  audioWatchPath: string;
  sttLanguage: string;
  exporterApple: boolean;
  exporterMarkdown: boolean;
  recordingBitrateKbps: number;
}

type PermState = 'granted' | 'denied' | 'not-determined' | 'unknown';
interface AudioPerms { mic: PermState; audioCapture: PermState; }

export function SettingsView({ onBack }: { onBack: () => void }): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [perms, setPerms] = useState<AudioPerms | null>(null);

  useEffect(() => {
    void (async () => {
      setS((await api.settings.getAll()) as Settings);
      setModels((await api.models.list()) as string[]);
      setPerms((await api.permissions.audio()) as AudioPerms);
    })();
  }, []);

  if (!s) return <div className="p-8">Loading…</div>;

  async function update<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));
    await api.settings.set(key, value);
  }

  async function recheckPerms(): Promise<void> {
    setPerms((await api.permissions.audio()) as AudioPerms);
  }

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-ink-muted text-sm">
          ← Back
        </button>
        <h1 className="font-semibold">Settings</h1>
      </div>

      <Field label="LM Studio URL (chat / LLM)">
        <input
          value={s.lmStudioUrl}
          onChange={(e) => update('lmStudioUrl', e.target.value)}
          className="input"
        />
      </Field>
      <Field label="LLM Model (loaded in LM Studio)">
        <select
          value={s.llmModel}
          onChange={(e) => update('llmModel', e.target.value)}
          className="input"
        >
          <option value="">(choose)</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <div className="text-xs text-ink-muted mt-1">
          Loaded from {s.lmStudioUrl}/v1/models. Used for summarization and action-item extraction.
        </div>
      </Field>
      <Field label="STT URL (whisper.cpp server)">
        <input
          value={s.sttUrl}
          onChange={(e) => update('sttUrl', e.target.value)}
          className="input"
        />
        <div className="text-xs text-ink-muted mt-1">
          Default http://127.0.0.1:8080. Start with: ./scripts/whisper-server.sh daemon
        </div>
      </Field>
      <Field label="STT Model name">
        <input
          value={s.sttModel}
          onChange={(e) => update('sttModel', e.target.value)}
          className="input"
        />
        <div className="text-xs text-ink-muted mt-1">
          Informational. The actual model is whichever one whisper-server was started with.
        </div>
      </Field>
      <Field label="Library Path">
        <input
          value={s.libraryPath}
          onChange={(e) => update('libraryPath', e.target.value)}
          className="input"
        />
      </Field>
      <Field label="Recordings folder">
        <input
          value={s.audioWatchPath}
          onChange={(e) => update('audioWatchPath', e.target.value)}
          className="input"
        />
        <div className="text-xs text-ink-muted mt-1">
          Where dropped MP3s and external recordings are watched. The built-in recorder writes to ~/Music/MeetingNotes.
        </div>
      </Field>
      <Field label="STT Language">
        <input
          value={s.sttLanguage}
          onChange={(e) => update('sttLanguage', e.target.value)}
          className="input"
        />
      </Field>

      <section className="border-t border-surface-border pt-5">
        <div className="text-xs font-bold text-ink-muted uppercase mb-2">Recording quality</div>
        <label className="block">
          <div className="text-sm text-ink mb-1">AAC bitrate</div>
          <select
            value={s.recordingBitrateKbps}
            onChange={(e) => update('recordingBitrateKbps', Number(e.target.value))}
            className="input"
          >
            <option value={96}>96 kbps (smallest files)</option>
            <option value={128}>128 kbps (balanced — default)</option>
            <option value={192}>192 kbps (highest quality)</option>
          </select>
          <div className="text-xs text-ink-muted mt-1">
            Applies to new recordings. Higher bitrate = bigger files but cleaner playback.
          </div>
        </label>
      </section>

      <section className="border-t border-surface-border pt-5">
        <div className="flex items-center gap-2 mb-2">
          <div className="text-xs font-bold text-ink-muted uppercase flex-1">Permissions</div>
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
            <PermRow label="Microphone" state={perms.mic} />
            <PermRow label="System audio" state={perms.audioCapture} />
            <div className="text-xs text-ink-muted mt-2">
              Both must be granted for the built-in recorder to capture meeting audio. Open System Settings → Privacy &amp; Security to change either.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function PermRow({ label, state }: { label: string; state: PermState }): JSX.Element {
  const cls = state === 'granted'
    ? 'text-status-ok'
    : state === 'denied'
      ? 'text-rose-600'
      : 'text-ink-muted';
  const txt = state === 'granted' ? '✓ Granted'
    : state === 'denied' ? '✗ Denied'
      : state === 'not-determined' ? 'Not granted yet'
        : 'Unknown';
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="flex-1">{label}</span>
      <span className={`font-semibold ${cls}`}>{txt}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="block">
      <div className="text-xs font-bold text-ink-muted uppercase mb-1">{label}</div>
      {children}
    </label>
  );
}
