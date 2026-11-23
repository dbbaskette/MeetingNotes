// electron/renderer/src/views/SettingsView.tsx
// Settings shell: owns the one Settings state object, the per-key save queue
// and the save banner; each section's controls live in ./settings/ (#256).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../ipc/client';
import type { NavTarget } from '../components/AppNav';
import { AppHeader, APP_SHELL_CLASS } from '../components/AppHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SetupHealth } from '../components/SetupHealth';
import { TerminologySettings } from '../components/Terminology';
import { ObsidianSettings } from '../components/ObsidianSettings';
import { SettingsNavigation, SettingsSection } from '../components/SettingsNavigation';
import { setUnsavedGuard } from '../lib/unsaved-guard';
import type { SettingsSectionName } from '../lib/deep-link';
import { effectiveLlmUrl as providerUrl } from '../../../shared/inference-endpoints.js';
import type { AudioPerms, ProviderAvailability, Settings, SpeakerListEntry } from './settings/types';
import { SaveStatus } from './settings/SaveStatus';
import { MeetingDetectionSettings, MenuBarShortcutSettings, PermissionsSettings } from './settings/RecordingSettings';
import {
  AutoProcessingSettings, SpeakerMatchingSettings, SummaryStyleSettings, SummaryTemplateSettings,
  TranscriptionEngineSettings, TranscriptionLanguageSettings,
} from './settings/ProcessingSettings';
import { AppearanceSettings, IdentitySettings } from './settings/OrganizationSettings';
import { GoogleAccountCard, WebhookExporterCard } from './settings/IntegrationsSettings';
import { StorageSettings } from './settings/StorageSettings';
import { DiagnosticsSection, SummaryProviderSettings } from './settings/AdvancedSettings';

export function SettingsView({ initialSection,
  onNav,
  onRunSetupAgain,
}: {
  /** Shared nav tabs (Library / Weekly / Settings) — routes through
   *  App's history-aware navigate(). 'settings' never arrives. */
  onNav: (target: NavTarget) => void;
  onRunSetupAgain?: () => void;
  /** Deep link: open on this section (for example from "Connect a Google account in Settings"). */
  initialSection?: SettingsSectionName;
}): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [perms, setPerms] = useState<AudioPerms | null>(null);
  const [speakers, setSpeakers] = useState<SpeakerListEntry[]>([]);
  const [speakerQuery, setSpeakerQuery] = useState('');
  const matchingSpeakers = useMemo(() => {
    const needle = speakerQuery.toLocaleLowerCase();
    return speakers.filter(sp => sp.displayName.toLocaleLowerCase().includes(needle));
  }, [speakers, speakerQuery]);
  const [speakerLimit, setSpeakerLimit] = useState(10);
  const [providers, setProviders] = useState<ProviderAvailability | null>(null);
  const [healthCheck, setHealthCheck] = useState<{ modelId: string; state: 'checking' | 'ok' | 'loops' } | null>(null);
  const [saveStates, setSaveStates] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const queues = useRef<Record<string, Promise<unknown>>>({});
  const revisions = useRef<Record<string, number>>({});
  const [leaveOpen, setLeaveOpen] = useState(false);
  const leaveResolver = useRef<((leave: boolean) => void) | null>(null);
  useEffect(() => {
    const unsaved = Object.values(saveStates).some(state => state !== 'Saved');
    setUnsavedGuard(unsaved ? () => new Promise<boolean>(resolve => {leaveResolver.current = resolve; setLeaveOpen(true);}) : null);
    return () => setUnsavedGuard(null);
  }, [saveStates]);
  useEffect(() => () => {leaveResolver.current?.(false);}, []);
  // "Saved" confirmations clear themselves; the banner used to keep every
  // key that had ever been touched for the whole visit (#299).
  useEffect(() => {
    if (!Object.values(saveStates).includes('Saved')) return;
    const timer = window.setTimeout(() => setSaveStates(previous => Object.fromEntries(Object.entries(previous).filter(([, state]) => state !== 'Saved'))), 2500);
    return () => window.clearTimeout(timer);
  }, [saveStates]);
  // The model list belongs to whichever server the active provider points at,
  // so it is re-read when the provider or URL changes and after a successful
  // Test, not only once when Settings opens.
  const [modelsLoading, setModelsLoading] = useState(false);
  const refreshModels = useCallback(async (): Promise<void> => {
    setModelsLoading(true);
    try { setModels(await api.models.list()); }
    catch { /* keep the list we have; the saved model still shows */ }
    finally { setModelsLoading(false); }
  }, []);

  useEffect(() => {
    void (async () => {
      setS((await api.settings.getAll()) as Settings);
      await Promise.all([
        api.models.list().then(setModels), api.permissions.audio().then(setPerms),
        api.speakers.list().then(setSpeakers), api.llm.detectProviders().then(setProviders),
      ]);
    })().catch(e => setLoadError((e as Error).message));
  }, []);

  if (!s) return <div className="p-8" role="status">{loadError ? `Could not load Settings: ${loadError}` : 'Loading…'}</div>;

  // The chat client follows the active provider, not the LM Studio URL field —
  // managed modes hardcode their ports (see LMStudioClient wiring in main).
  // Test buttons and captions must probe the same endpoint the pipeline uses,
  // otherwise a healthy ollama setup "fails" a test against :1234.
  const effectiveLlmUrl = providerUrl(s.summaryProvider, s.lmStudioUrl);
  const providerLabel =
    s.summaryProvider === 'lm-studio' ? 'LM Studio, managed'
    : s.summaryProvider === 'ollama' ? 'Ollama, managed'
    : 'external server';

  function edit<K extends keyof Settings>(key: K, value: Settings[K]): void {
    revisions.current[key] = (revisions.current[key] ?? 0) + 1;
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaveStates(previous => ({...previous, [key]: 'Unsaved — leave the field to save'}));
  }
  async function update<K extends keyof Settings>(key: K, value: Settings[K]): Promise<boolean> {
    const revision = revisions.current[key] = (revisions.current[key] ?? 0) + 1;
    const pathSetting = key === 'libraryPath' || key === 'audioWatchPath';
    if (!pathSetting) setS(prev => prev ? {...prev, [key]: value} : prev);
    setSaveStates(previous => ({...previous, [key]: 'Saving…'}));
    const request = (queues.current[key] ?? Promise.resolve()).then(() => api.settings.set(key, value));
    queues.current[key] = request.catch(() => {});
    try {
      const canonical = await request as Settings[K];
      if (revisions.current[key] === revision) {
        setS(prev => prev && (pathSetting || prev[key] === value) ? {...prev, [key]: canonical} : prev);
        setSaveStates(previous => ({...previous, [key]: 'Saved'}));
      }
      return true;
    } catch (e) {
      if (revisions.current[key] === revision) setSaveStates(previous => ({...previous, [key]: `Couldn’t save: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')}`}));
      return false;
    }
  }

  async function changeLlmModel(modelId: string): Promise<void> {
    if (!await update('llmModel', modelId)) return;
    if (!modelId) { setHealthCheck(null); return; }
    setHealthCheck({ modelId, state: 'checking' });
    try {
      const result = await api.llm.healthCheckModel(modelId);
      setHealthCheck({ modelId, state: result.verdict });
    } catch {
      setHealthCheck(null); // best-effort canary; don't block the UI on a failed check
    }
  }

  async function recheckPerms(): Promise<void> {
    setPerms((await api.permissions.audio()) as AudioPerms);
  }

  async function refreshSpeakers(): Promise<void> {
    setSpeakers((await api.speakers.list()) as SpeakerListEntry[]);
  }

  return (
    // Same shell and header as the other top-level views so the navigation
    // does not shift; the form itself stays a narrow column inside it (#296).
    <div className={APP_SHELL_CLASS}>
      <ConfirmDialog open={leaveOpen} title="Leave Settings with unsaved changes?" body="Some changes have not been saved. Stay to finish saving or correct any errors." confirmLabel="Leave Settings" onCancel={() => {leaveResolver.current?.(false); leaveResolver.current = null; setLeaveOpen(false);}} onConfirm={() => {leaveResolver.current?.(true); leaveResolver.current = null; setLeaveOpen(false);}}/>
      <AppHeader active="settings" onNav={onNav} pageTitle="Settings" className="mb-0">
        {onRunSetupAgain && (
          <button
            onClick={onRunSetupAgain}
            className="ml-auto text-sm text-brand-indigo hover:underline"
          >
            Run setup again
          </button>
        )}
      </AppHeader>
      <div className="settings-view flex-1 min-h-0 flex flex-col max-w-2xl mx-auto w-full">
      <SaveStatus saveStates={saveStates} loadError={loadError} onRetry={key => void update(key as keyof Settings, s[key as keyof Settings])} />
      <SetupHealth />
      <SettingsNavigation initialSection={initialSection}>
      <SettingsSection section="Processing" keywords="Apple SpeakerKit WhisperKit native speech language transcription engine accuracy STT setup">
        <TranscriptionEngineSettings s={s} setS={setS} update={update} />
      </SettingsSection>
      <SettingsSection section="Processing" keywords="speaker voices voiceprints automatic match identity similarity">
        <SpeakerMatchingSettings s={s} update={update} />
      </SettingsSection>
      <SettingsSection section="Processing" keywords="automatic auto process recordings queue">
        <AutoProcessingSettings s={s} update={update} />
      </SettingsSection>
      <SettingsSection section="Processing" keywords="notes summary template group 1:1 standup customer interview decision meeting type">
        <SummaryTemplateSettings />
      </SettingsSection>
      <SettingsSection section="Organization" keywords="dictionary terminology corrections words">
        <TerminologySettings />
      </SettingsSection>
      <SettingsSection section="Integrations" keywords="Obsidian vault sync">
        <ObsidianSettings />
      </SettingsSection>
      <SettingsSection section="Advanced" keywords="summary provider lifecycle LLM LM Studio Ollama endpoint URL model">
        <SummaryProviderSettings s={s} edit={edit} update={update} providers={providers} models={models} modelsLoading={modelsLoading}
          refreshModels={refreshModels} healthCheck={healthCheck} changeLlmModel={changeLlmModel}
          effectiveLlmUrl={effectiveLlmUrl} providerLabel={providerLabel} />
      </SettingsSection>
      <SettingsSection section="Processing" keywords="summary detail concise standard detailed thinking language">
        <SummaryStyleSettings s={s} update={update} />
      </SettingsSection>
      <SettingsSection section="Organization" keywords="appearance theme light dark system">
        <AppearanceSettings s={s} update={update} />
      </SettingsSection>
      <SettingsSection section="Storage" keywords="library path recordings folders storage watch logs models cache">
        <StorageSettings s={s} update={update} />
      </SettingsSection>
      <SettingsSection section="Processing" keywords="STT transcription language">
        <TranscriptionLanguageSettings s={s} edit={edit} update={update} />
      </SettingsSection>
      <SettingsSection section="Organization" keywords="your name speakers roster rename merge weekly owner">
        <IdentitySettings s={s} edit={edit} update={update} speakers={speakers} matchingSpeakers={matchingSpeakers}
          speakerQuery={speakerQuery} setSpeakerQuery={setSpeakerQuery} speakerLimit={speakerLimit} setSpeakerLimit={setSpeakerLimit}
          refreshSpeakers={refreshSpeakers} />
      </SettingsSection>
      <SettingsSection section="Recording" keywords="audio capture meeting auto detect browser native Zoom silence stop permissions microphone">
        <MeetingDetectionSettings s={s} update={update} />
      </SettingsSection>
      <SettingsSection section="Integrations" keywords="webhook exporter notifications URL token payload Telegram Slack">
      <WebhookExporterCard
        settings={s}
        onUpdate={(patch) => {for (const [key,value] of Object.entries(patch)) edit(key as keyof Settings, value as Settings[keyof Settings]);}}
        onPersist={update}
      />

      </SettingsSection>
      <SettingsSection section="Integrations" keywords="Google account OAuth credentials export Tasks Docs">
      <GoogleAccountCard
        settings={s}
        onUpdate={(patch) => {for (const [key,value] of Object.entries(patch)) edit(key as keyof Settings, value as Settings[keyof Settings]);}}
        onPersist={update}
      />

      </SettingsSection>
      <SettingsSection section="Recording" keywords="menu bar tray status icon global shortcut hotkey keyboard start stop">
        <MenuBarShortcutSettings s={s} update={update} />
      </SettingsSection>
      <SettingsSection section="Recording" keywords="permissions microphone system audio privacy security">
        <PermissionsSettings perms={perms} recheckPerms={recheckPerms} />
      </SettingsSection>
      <SettingsSection section="Advanced" keywords="diagnostics logs warnings errors debug">
      <DiagnosticsSection />
      </SettingsSection>
      </SettingsNavigation>
      </div>
    </div>
  );
}
