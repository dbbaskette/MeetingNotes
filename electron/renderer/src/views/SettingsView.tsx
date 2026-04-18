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
}

export function SettingsView({ onBack }: { onBack: () => void }): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      setS((await api.settings.getAll()) as Settings);
      setModels((await api.models.list()) as string[]);
    })();
  }, []);

  if (!s) return <div className="p-8">Loading…</div>;

  async function update<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));
    await api.settings.set(key, value);
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
      <Field label="Audio Hijack Session Name">
        <input
          value={s.audioHijackSessionName}
          onChange={(e) => update('audioHijackSessionName', e.target.value)}
          className="input"
        />
      </Field>
      <Field label="Library Path">
        <input
          value={s.libraryPath}
          onChange={(e) => update('libraryPath', e.target.value)}
          className="input"
        />
      </Field>
      <Field label="Audio Watch Path">
        <input
          value={s.audioWatchPath}
          onChange={(e) => update('audioWatchPath', e.target.value)}
          className="input"
        />
      </Field>
      <Field label="STT Language">
        <input
          value={s.sttLanguage}
          onChange={(e) => update('sttLanguage', e.target.value)}
          className="input"
        />
      </Field>
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
