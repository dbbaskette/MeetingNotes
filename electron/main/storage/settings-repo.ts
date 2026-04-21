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
  audioWatchPath: string;
  sttLanguage: string;
  exporterApple: boolean;
  exporterMarkdown: boolean;
  /** AAC bitrate the built-in helper records at, in kbps. UI offers 96/128/192. */
  recordingBitrateKbps: number;
  /** When true, poll the frontmost browser tab for meeting URLs and prompt
   *  to start recording. Opt-in because it requires AppleScript Automation
   *  permission for each browser. */
  autoDetectMeetings: boolean;
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
  audioWatchPath: path.join(os.homedir(), 'Music', 'MeetingNotes'),
  sttLanguage: 'en',
  exporterApple: true,
  exporterMarkdown: true,
  recordingBitrateKbps: 128,
  autoDetectMeetings: false,
};

type Key = keyof Settings;

export class SettingsRepo {
  constructor(private readonly db: Database.Database) {}

  get<K extends Key>(key: K): Settings[K] {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!r) return DEFAULT_SETTINGS[key];
    return JSON.parse(r.value) as Settings[K];
  }

  set<K extends Key>(key: K, value: Settings[K]): void {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value));
  }

  getAll(): Settings {
    const out = { ...DEFAULT_SETTINGS };
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    for (const { key, value } of rows) {
      if (key in DEFAULT_SETTINGS) {
        (out as Record<string, unknown>)[key] = JSON.parse(value);
      }
    }
    return out;
  }
}
