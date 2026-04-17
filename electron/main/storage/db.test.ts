import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from './db';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mn-db-'));
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('openDb', () => {
  it('creates schema with expected tables', () => {
    const dir = tmp(); dirs.push(dir);
    const db = openDb(path.join(dir, 'db.sqlite'));
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'meetings', 'speakers', 'meeting_speakers', 'action_items', 'settings', 'schema_version',
    ]));
  });

  it('is idempotent (running twice keeps version)', () => {
    const dir = tmp(); dirs.push(dir);
    const dbPath = path.join(dir, 'db.sqlite');
    openDb(dbPath).close();
    const db = openDb(dbPath);
    const v = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v.version).toBeGreaterThan(0);
  });
});
