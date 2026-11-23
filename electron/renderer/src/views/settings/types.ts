// electron/renderer/src/views/settings/types.ts
// Shared shapes for the Settings view and its per-section panels (#256).
import type { TranscriptionEngine } from '../../../../shared/native-speech';

export interface Settings {
  lmStudioUrl: string;
  llmModel: string;
  libraryPath: string;
  audioWatchPath: string;
  sttLanguage: string;
  transcriptionEngine?: TranscriptionEngine;
  exporterWebhook: boolean;
  webhookUrl: string;
  webhookSecret: string;
  webhookTemplate: 'compact' | 'full' | 'telegram-markdown' | 'slack-blocks';
  webhookOwnerFilter: 'mine' | 'all' | 'none';
  webhookLastResult: { ts: string; status: number | null; error: string | null } | null;
  autoDetectMeetings: {
    browserTabs: boolean;
    nativeApps: boolean;
    silenceMs: number;
  };
  autoRecordZoom: boolean;
  autoStopOnSilence: boolean;
  silencePromptAfterS: number;
  silenceCountdownS: number;
  autoProcessRecordings: boolean;
  autoMatchSpeakers: boolean;
  notesFirst: boolean;
  showMenuBarIcon: boolean;
  recordShortcut: string;
  userName: string;
  userSpeakerId: string | null;
  summaryProvider: 'external' | 'lm-studio' | 'ollama';
  llmContextLength: number;
  summaryDetail: 'concise' | 'standard' | 'detailed';
  disableThinking: boolean;
  reasoningEffort: 'none' | 'minimal' | 'low' | 'default';
  theme: 'system' | 'light' | 'dark';
  googleClientId: string;
  googleClientSecret: string;
}

export interface SpeakerListEntry { id: string; displayName: string }
export interface ProviderAvailability {
  lmStudio: { binary: boolean; running: boolean };
  ollama: { binary: boolean; running: boolean };
}

export type PermState = 'granted' | 'denied' | 'not-determined' | 'unknown';
export interface AudioPerms { mic: PermState; audioCapture: PermState; }

/** Local edit: updates the field and marks it unsaved until `update` runs. */
export type EditSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => void;
/** Persists one setting through the per-key save queue; resolves to whether it saved. */
export type UpdateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<boolean>;
