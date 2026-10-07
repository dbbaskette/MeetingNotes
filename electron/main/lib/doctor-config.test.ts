import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true }); });
function fixture(values: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-doctor-fixture-'));
  dirs.push(dir);
  const file = path.join(dir, 'settings.sqlite');
  const db = new Database(file);
  try {
    db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)');
    for (const [key, value] of Object.entries(values)) {
      db.prepare('INSERT INTO settings VALUES (?, ?)').run(key, JSON.stringify(value));
    }
  } finally { db.close(); }
  return file;
}
function config(dbPath: string, overrides: Record<string, string> = {}): string[] {
  const env = { ...process.env };
  for (const key of ['LM_STUDIO_URL', 'STT_URL', 'MEETINGNOTES_LIB']) delete env[key];
  return execFileSync('bash', ['-uc', 'source "$1"; printf "%s\\n" "$LIB" "$STT_URL" "$PROVIDER" "$LLM_URL"',
    'fixture', path.resolve('scripts/doctor-config.sh')], {
    encoding: 'utf8', env: { ...env, MEETINGNOTES_SETTINGS_DB: dbPath, ...overrides },
  }).trimEnd().split('\n');
}
describe('doctor read-only configuration', () => {
  it.each([
    ['external', 'http://external.example:9000'],
    ['ollama', 'http://127.0.0.1:11434'],
    ['lm-studio', 'http://127.0.0.1:1234'],
  ])('uses the configured %s provider and relocated library', (provider, endpoint) => {
    const file = fixture({ libraryPath: '/fixture/relocated library', summaryProvider: provider,
      lmStudioUrl: 'http://external.example:9000', sttUrl: 'http://127.0.0.1:9090' });
    const before = fs.readFileSync(file);
    expect(config(file)).toEqual(['/fixture/relocated library', 'http://127.0.0.1:9090', provider, endpoint]);
    expect(fs.readFileSync(file)).toEqual(before);
  });
  it('preserves explicit endpoint and library overrides even for managed providers', () => {
    const file = fixture({ summaryProvider: 'ollama' });
    expect(config(file, { MEETINGNOTES_LIB: '/fixture/override', STT_URL: 'http://fixture.example:8001/',
      LM_STUDIO_URL: 'http://fixture.example:8002/' })).toEqual([
      '/fixture/override', 'http://fixture.example:8001', 'ollama', 'http://fixture.example:8002',
    ]);
  });
  it('decodes JSON strings without stripping embedded quotes or escapes', () => {
    const library = '/fixture/Meetings "quoted" \\ café';
    expect(config(fixture({ libraryPath: library }))[0]).toBe(library);
  });
  it('uses defaults without creating a missing settings database', () => {
    const file = fixture(); fs.unlinkSync(file);
    expect(config(file)).toEqual([path.join(os.homedir(), 'Documents', 'MeetingNotes'),
      'http://127.0.0.1:8080', 'external', 'http://localhost:1234']);
    expect(fs.existsSync(file)).toBe(false);
  });
  it('never creates a library database while resolving relocated configuration', () => {
    const file = fixture();
    const db = new Database(file);
    try {
      db.prepare('INSERT INTO settings VALUES (?, ?)').run('libraryPath',
        JSON.stringify(path.join(path.dirname(file), 'missing-library')));
    } finally { db.close(); }
    config(file);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.sqlite']);
  });
});
