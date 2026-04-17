import type Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

export interface Settings {
  lmStudioUrl: string;
  sttModel: string;
  llmModel: string;
  audioHijackSessionName: string;
  libraryPath: string;
  audioWatchPath: string;
  sttLanguage: string;
  exporterApple: boolean;
  exporterMarkdown: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  lmStudioUrl: 'http://localhost:1234',
  sttModel: '',
  llmModel: '',
  audioHijackSessionName: 'Meeting',
  libraryPath: path.join(os.homedir(), 'Documents', 'MeetingNotes'),
  audioWatchPath: path.join(os.homedir(), 'Music', 'Audio Hijack'),
  sttLanguage: 'en',
  exporterApple: true,
  exporterMarkdown: true,
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
