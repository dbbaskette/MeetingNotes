// electron/renderer/src/views/settings/ProcessingSettings.tsx
// Processing section: transcription engine and language, speaker matching,
// automatic processing, summary templates, detail level and reasoning effort.
import type { Dispatch, SetStateAction } from 'react';
import { GroupTemplateDefaults } from '../../components/SummaryTemplates';
import { NativeSpeechPanel } from '../../components/NativeSpeechPanel';
import { SPEAKER_AUTO_MATCH } from '../../../../shared/speaker-matching';
import { Field } from './Field';
import type { EditSetting, Settings, UpdateSetting } from './types';

export function TranscriptionEngineSettings({ s, setS, update }: {
  s: Settings;
  setS: Dispatch<SetStateAction<Settings | null>>;
  update: UpdateSetting;
}): JSX.Element {
  return (
        <NativeSpeechPanel language={s.sttLanguage} engine={s.transcriptionEngine ?? 'apple'}
          onEngineChange={async engine => {
            // A refused change (processing or setup is running) must not leave
            // the control showing an engine that was not saved.
            const previous = s.transcriptionEngine ?? 'apple';
            if (!await update('transcriptionEngine', engine)) setS(current => current ? { ...current, transcriptionEngine: previous } : current);
          }} />
  );
}

export function SpeakerMatchingSettings({ s, update }: { s: Settings; update: UpdateSetting }): JSX.Element {
  return (
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={s.autoMatchSpeakers ?? false}
            onChange={e => void update('autoMatchSpeakers', e.target.checked)} />
          <span>Automatically match known voices
            <span className="block text-xs text-ink-muted mt-1">Off by default. Applies on the next identification run, not to existing assignments. Requires similarity ≥ {SPEAKER_AUTO_MATCH.similarity}, a {SPEAKER_AUTO_MATCH.margin} lead over the next candidate, and {SPEAKER_AUTO_MATCH.cleanDurationS}s of non-overlapping speech across {SPEAKER_AUTO_MATCH.cleanTurns} turns. Short, ambiguous or duplicate matches stay in review. A clear best guess with similarity ≥ {SPEAKER_AUTO_MATCH.suggestSimilarity} is offered for one-click confirmation instead.</span>
            <span className="block text-xs text-ink-muted mt-1">Experimental heuristics, not confidence percentages. Automatic names are labeled and remain editable. Only your confirmations teach voiceprints.</span>
          </span>
        </label>
  );
}

export function AutoProcessingSettings({ s, update }: { s: Settings; update: UpdateSetting }): JSX.Element {
  return (
    <>
        <label className="flex items-start gap-3 text-sm mb-4">
          <input type="checkbox" checked={s.notesFirst ?? false} onChange={e => void update('notesFirst', e.target.checked)} />
          <span>Generate notes before naming every voice
            <span className="block text-xs text-ink-muted mt-1">Keep processing with speaker labels when names are unknown. Name voices later; exact speaker labels in notes and action items can be resolved without regenerating your notes. Existing saved weekly reports do not change.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={s.autoProcessRecordings ?? false} onChange={e => void update('autoProcessRecordings', e.target.checked)} />
          <span>Process recordings automatically when capture finishes
            <span className="block text-xs text-ink-muted mt-1">Off by default. Applies only to new built-in recordings with usable finalized audio, not imports or recovery. Queue pause and voice review still apply.</span>
          </span>
        </label>
    </>
  );
}

export function SummaryTemplateSettings(): JSX.Element {
  return <section className="border-t border-surface-border pt-5"><GroupTemplateDefaults /></section>;
}

export function SummaryStyleSettings({ s, update }: { s: Settings; update: UpdateSetting }): JSX.Element {
  return (
    <>
      <Field label="Summary detail level">
        <select
          value={s.summaryDetail}
          onChange={(e) => update('summaryDetail', e.target.value as Settings['summaryDetail'])}
          className="input"
        >
          <option value="concise">Concise — tight, skimmable, one bullet per point</option>
          <option value="standard">Standard — balanced detail vs. brevity</option>
          <option value="detailed">Detailed — full context, trade-offs, reasoning</option>
        </select>
        <div className="text-xs text-ink-muted mt-1">
          Steers how verbose the summary prompt asks the model to be, so the level
          stays consistent across different local models. Applies to the next summary.
        </div>
      </Field>
      <Field label="Model thinking / reasoning effort">
        <select
          aria-label="Model thinking / reasoning effort"
          value={s.reasoningEffort ?? (s.disableThinking ? 'none' : 'default')}
          onChange={(e) => {
            const effort = e.target.value as Settings['reasoningEffort'];
            void update('reasoningEffort', effort);
          }}
          className="input"
        >
          <option value="none">Off (recommended) — skip chain-of-thought</option>
          <option value="minimal">Minimal — brief reasoning cap</option>
          <option value="low">Low — light reasoning cap</option>
          <option value="default">Model default — no thinking override</option>
        </select>
        <div className="text-xs text-ink-muted mt-1">
          Reasoning-capable models (Gemma 4, Qwen3, DeepSeek-R1, gpt-oss, Inkling-2-Mini)
          can burn their token budget &ldquo;thinking&rdquo; and return no summary.
          <strong> Off</strong> sends <code className="mx-0.5">enable_thinking: false</code> and{' '}
          <code className="mx-0.5">reasoning_effort: &quot;none&quot;</code>; <strong>Minimal</strong> /{' '}
          <strong>Low</strong> cap effort via <code className="mx-0.5">reasoning_effort</code>.
          If LM Studio ignores API overrides for a model, add{' '}
          <code className="mx-0.5">{'{%- set reasoning_effort = "none" %}'}</code> at the top of
          its Jinja prompt template in LM Studio.
        </div>
      </Field>
    </>
  );
}

export function TranscriptionLanguageSettings({ s, edit, update }: { s: Settings; edit: EditSetting; update: UpdateSetting }): JSX.Element {
  return (
      <Field label="STT Language">
        <input
          value={s.sttLanguage}
          onChange={(e) => edit('sttLanguage', e.target.value)} onBlur={() => void update('sttLanguage', s.sttLanguage)}
          className="input"
        />
        <p className="text-xs text-ink-muted mt-1">Use a supported Apple locale (for example en-US); en selects en-US. After saving a new language, check or prepare its assets above before processing. WhisperKit uses the language part only (en, de, ja).</p>
      </Field>
  );
}
