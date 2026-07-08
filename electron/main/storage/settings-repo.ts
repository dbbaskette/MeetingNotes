import type Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

export interface Settings {
  lmStudioUrl: string;
  /** OpenAI-compatible STT endpoint (whisper.cpp's whisper-server, etc.). */
  sttUrl: string;
  /** Model id for STT. For whisper.cpp this is informational; the loaded model is set at server start. */
  sttModel: string;
  llmModel: string;
  audioHijackSessionName: string;
  libraryPath: string;
  /** OPTIONAL extra folder watched for dropped audio. Empty by default.
   *  The library's recordings dir (`<libraryPath>/recordings`) and the legacy
   *  `~/Music/MeetingNotes` are ALWAYS watched regardless of this value — the
   *  built-in recorder writes into the library, so this is purely an additional
   *  drop location for users who want one. See libraryWatchPaths(). */
  audioWatchPath: string;
  sttLanguage: string;
  exporterApple: boolean;
  exporterMarkdown: boolean;
  /** Push a meeting.completed JSON payload to a user-configured endpoint
   *  when the pipeline finishes a meeting (#79). All fields below are
   *  ignored unless this is true. */
  exporterWebhook: boolean;
  /** Destination endpoint. Must be HTTPS unless it's a localhost address. */
  webhookUrl: string;
  /** Optional bearer token. Sent as `Authorization: Bearer <secret>` if set.
   *  Redacted from logs and the "Send test" preview. */
  webhookSecret: string;
  /** Built-in template selector. `compact` and `full` are JSON; the other
   *  two flatten the payload for Telegram and Slack respectively. */
  webhookTemplate: 'compact' | 'full' | 'telegram-markdown' | 'slack-blocks';
  /** Action-item owner filter.
   *   - `mine` = only items owned by the local user (settings.userSpeakerId)
   *   - `all`  = every action item
   *   - `none` = summary only, no action items */
  webhookOwnerFilter: 'mine' | 'all' | 'none';
  /** Last delivery attempt — null until the first send. The renderer
   *  surfaces this in the Settings card so users can see what happened
   *  without tailing the log. */
  webhookLastResult: {
    ts: string;
    status: number | null;
    error: string | null;
  } | null;
  /** AAC bitrate the built-in helper records at, in kbps. UI offers 96/128/192. */
  recordingBitrateKbps: number;
  /** Meeting auto-detect configuration. `browserTabs` polls the frontmost
   *  browser tab for known meeting URLs; `nativeApps` polls CoreAudio for
   *  Zoom / Teams / FaceTime / Slack / Discord / WhatsApp producing audio.
   *  `silenceMs` is the sustained-audio debounce for the native-app path
   *  (filters out notification beeps). Backwards-compat: a legacy boolean
   *  value flips both `browserTabs` and `nativeApps` to that boolean.
   *  Issues #12, #78. */
  autoDetectMeetings: {
    browserTabs: boolean;
    nativeApps: boolean;
    silenceMs: number;
  };
  /** When the native-app detector fires for Zoom (`us.zoom.xos`), skip
   *  the banner and start recording immediately. Trades the banner's
   *  always-confirm posture for "I know I always want this" convenience.
   *  Only Zoom for now — Teams / FaceTime / Slack / etc. still surface
   *  the banner. */
  autoRecordZoom: boolean;
  /** Display name used for the local user's voice in stem-aware transcripts.
   *  Empty → the literal "You" is used. (#13 Phase 3.) */
  userName: string;
  /** ISO timestamp of the first-run onboarding wizard completion or skip.
   *  Null → wizard shows on next launch. Set by OnboardingView. (#43) */
  onboardedAt: string | null;
  /** Roster speaker that is the local user. When set, the weekly view
   *  pins this speaker's open action items at the top in a "You"
   *  group. Null = no preference; weekly view groups action items by
   *  owner without a "You" pin. */
  userSpeakerId: string | null;
  /** Provider that hosts the summarization / extraction LLM.
   *  - 'external': user runs LM Studio / Ollama / etc. themselves;
   *    we just POST to lmStudioUrl. (Backwards-compatible default.)
   *  - 'lm-studio': MeetingNotes spawns `lms server start` on demand
   *    and shuts it down after idle.
   *  - 'ollama': MeetingNotes spawns `ollama serve` on demand. */
  summaryProvider: 'external' | 'lm-studio' | 'ollama';
  /** How verbose the generated summary should be. Drives which "Length &
   *  depth" guidance gets baked into the summarization prompt (see
   *  buildSummaryPrompt). Independent of the model — the prompt pins the
   *  target so different local models land at a consistent level.
   *   - 'concise'  = tight, skimmable, one bullet per point
   *   - 'standard' = balanced detail vs. brevity
   *   - 'detailed' = full context, trade-offs, reasoning (original behavior) */
  summaryDetail: 'concise' | 'standard' | 'detailed';
  /** Tell the LLM to skip its "thinking" / chain-of-thought. On by default.
   *  Reasoning-capable local models (Gemma 4, Qwen3, DeepSeek-R1, gpt-oss)
   *  otherwise spend their whole token budget reasoning and return no answer
   *  — which reads as an out-of-memory failure but isn't. When true, chat
   *  requests carry `chat_template_kwargs: { enable_thinking: false }`. Turn
   *  off only if a particular model misbehaves with the kwarg or you actually
   *  want its reasoning. See LMStudioClient.chat / ChatInput.disableThinking. */
  disableThinking: boolean;
  /** Cache of on-demand model health-check verdicts, keyed by model id, so
   *  a model already confirmed "ok" or "loops" isn't re-checked every time
   *  Settings re-renders. Populated by the llm:health-check-model IPC
   *  handler; the renderer only reads the immediate call result, but this
   *  cache lets a future "show past checks" UI reuse the data without a
   *  new schema migration. */
  modelHealthChecks: Record<string, { verdict: 'ok' | 'loops'; checkedAt: string }>;
  /** UI appearance. 'system' follows the OS; 'light'/'dark' force a mode.
   *  Applied in the renderer (App.tsx) and mirrored to nativeTheme in main. */
  theme: 'system' | 'light' | 'dark';
  /** Google OAuth client credentials (BYO). The user creates a "Desktop"
   *  OAuth client in Google Cloud and pastes these in. Empty = not configured
   *  (Google export unavailable). The client secret for a desktop client is
   *  non-confidential per Google's model. */
  googleClientId: string;
  googleClientSecret: string;
  /** Connected Google account email (display only). Null = not signed in. */
  googleAccountEmail: string | null;
  /** Refresh token, encrypted via Electron safeStorage and base64-encoded.
   *  Null = not signed in. Never logged. */
  googleRefreshTokenEnc: string | null;
  /** Last-known main-window bounds, saved on resize/move/close and restored
   *  at launch (after a visibility check against the current displays — see
   *  lib/window-bounds.ts). Null until the first save. */
  windowBounds: { x: number; y: number; width: number; height: number } | null;
}

export const DEFAULT_SETTINGS: Settings = {
  lmStudioUrl: 'http://localhost:1234',
  sttUrl: 'http://127.0.0.1:8080',
  sttModel: 'whisper-1',
  // Default to a small-to-mid LLM that actually fits in Apple Silicon VRAM
  // on an 8-hour meeting transcript. Gemma-31b and Qwen-35b-a3b both blow up
  // with Metal OOM on 13k+ token prompts on 24–32GB machines; qwen3.5-9b
  // does the same summarization job in a fraction of the memory and time.
  // Users can override in Settings if they've got the VRAM for a bigger one.
  llmModel: 'qwen/qwen3.5-9b',
  audioHijackSessionName: 'Meeting',
  libraryPath: path.join(os.homedir(), 'Documents', 'MeetingNotes'),
  audioWatchPath: '',
  sttLanguage: 'en',
  exporterApple: true,
  exporterMarkdown: true,
  exporterWebhook: false,
  webhookUrl: '',
  webhookSecret: '',
  webhookTemplate: 'compact',
  webhookOwnerFilter: 'mine',
  webhookLastResult: null,
  recordingBitrateKbps: 128,
  autoDetectMeetings: { browserTabs: false, nativeApps: false, silenceMs: 5000 },
  autoRecordZoom: false,
  userName: '',
  onboardedAt: null,
  userSpeakerId: null,
  summaryProvider: 'external',
  summaryDetail: 'detailed',
  disableThinking: true,
  modelHealthChecks: {},
  theme: 'system',
  googleClientId: '',
  googleClientSecret: '',
  googleAccountEmail: null,
  googleRefreshTokenEnc: null,
  windowBounds: null,
};

type Key = keyof Settings;

// Coerce legacy `autoDetectMeetings: boolean` rows into the current
// object shape (#78). Also fills in missing fields if a future setting
// gets added — callers always get a fully-populated object.
export function normalizeAutoDetectMeetings(value: unknown): Settings['autoDetectMeetings'] {
  const d = DEFAULT_SETTINGS.autoDetectMeetings;
  if (value === true) return { browserTabs: true, nativeApps: true, silenceMs: d.silenceMs };
  if (value === false || value == null) return { ...d };
  if (typeof value !== 'object') return { ...d };
  const v = value as Partial<Settings['autoDetectMeetings']>;
  return {
    browserTabs: typeof v.browserTabs === 'boolean' ? v.browserTabs : d.browserTabs,
    nativeApps: typeof v.nativeApps === 'boolean' ? v.nativeApps : d.nativeApps,
    silenceMs: typeof v.silenceMs === 'number' && Number.isFinite(v.silenceMs) && v.silenceMs >= 0
      ? v.silenceMs : d.silenceMs,
  };
}

export class SettingsRepo {
  constructor(private readonly db: Database.Database) {}

  get<K extends Key>(key: K): Settings[K] {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!r) return DEFAULT_SETTINGS[key];
    const parsed = JSON.parse(r.value) as unknown;
    if (key === 'autoDetectMeetings') {
      return normalizeAutoDetectMeetings(parsed) as Settings[K];
    }
    return parsed as Settings[K];
  }

  set<K extends Key>(key: K, value: Settings[K]): void {
    const toStore = key === 'autoDetectMeetings'
      ? normalizeAutoDetectMeetings(value)
      : value;
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(toStore));
  }

  getAll(): Settings {
    const out = { ...DEFAULT_SETTINGS };
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    for (const { key, value } of rows) {
      if (key in DEFAULT_SETTINGS) {
        const parsed = JSON.parse(value) as unknown;
        (out as Record<string, unknown>)[key] = key === 'autoDetectMeetings'
          ? normalizeAutoDetectMeetings(parsed)
          : parsed;
      }
    }
    return out;
  }
}
