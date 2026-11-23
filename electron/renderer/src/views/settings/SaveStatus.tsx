// electron/renderer/src/views/settings/SaveStatus.tsx
// The per-key save banner at the top of Settings, and the labels it prints.

/** Human-readable names for the save banner, which used to print raw setting
 *  keys such as "autoMatchSpeakers: Saved" (#299). */
const SETTING_LABELS: Record<string, string> = {
  lmStudioUrl: 'LLM server URL', llmModel: 'LLM model', summaryProvider: 'Summary provider', llmContextLength: 'Context length',
  summaryDetail: 'Summary detail', disableThinking: 'Disable model thinking', reasoningEffort: 'Reasoning effort',
  libraryPath: 'Library folder', audioWatchPath: 'Watched audio folder', sttLanguage: 'Transcription language', transcriptionEngine: 'Transcription engine',
  autoStopOnSilence: 'Ask before stopping a silent recording', silencePromptAfterS: 'Silence before asking', silenceCountdownS: 'Countdown before stopping',
  autoProcessRecordings: 'Process recordings automatically', autoMatchSpeakers: 'Match speakers automatically', notesFirst: 'Notes before speaker naming',
  showMenuBarIcon: 'Menu bar icon', recordShortcut: 'Start/stop shortcut', userName: 'Your name', userSpeakerId: 'You are…',
  theme: 'Appearance', googleClientId: 'Google client ID', googleClientSecret: 'Google client secret',
  webhookUrl: 'Webhook URL', webhookToken: 'Webhook token', webhookEnabled: 'Webhook exporter',
};
export function settingLabel(key: string): string {
  // Unknown keys still read as words rather than camelCase.
  return SETTING_LABELS[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

export function SaveStatus({ saveStates, loadError, onRetry }: {
  saveStates: Record<string, string>;
  loadError: string | null;
  /** Re-sends the current value of a key whose save failed. */
  onRetry: (key: string) => void;
}): JSX.Element {
  return (
      <div className="shrink-0 px-8 py-2 text-xs max-h-24 overflow-auto" aria-live="polite">
        {Object.entries(saveStates).map(([key, state]) => <div key={key} className={state.startsWith('Couldn') ? 'text-danger' : 'text-ink-muted'}>{settingLabel(key)}: {state}
          {state.startsWith('Couldn') && !['libraryPath','audioWatchPath'].includes(key) && <button className="ml-2 underline" onClick={() => onRetry(key)}>Retry</button>}
        </div>)}
        {loadError && <p role="alert" className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-danger-text">Some Settings information could not load: {loadError}</p>}
      </div>
  );
}
