import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';
import { SummaryTemplateStore } from './summary-template-store.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const group = '11111111-1111-4111-8111-111111111111';
  db.prepare("INSERT INTO groups (id, name, name_key, created_at, updated_at) VALUES (?, 'Customers', 'customers', '2026-01-01', '2026-01-01')").run(group);
  const insert = db.prepare("INSERT INTO meetings (id, slug, title, audio_path, status, pipeline_stage, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 'discovered', ?, '2026-01-01', '2026-01-01')");
  insert.run('grouped', 'grouped', 'Grouped', '/tmp/a.m4a', group);
  insert.run('loose', 'loose', 'Loose', '/tmp/b.m4a', null);
  return { db, group, store: new SummaryTemplateStore(db) };
}

describe('SummaryTemplateStore', () => {
  it('defaults to General', () => {
    const { store } = setup();
    expect(store.forMeeting('loose')).toEqual({ own: null, group: null, effective: 'general' });
    expect(store.effectiveFor('loose').id).toBe('general');
  });

  it('inherits the group default and lets a meeting override it', () => {
    const { store, group } = setup();
    store.setForGroup(group, 'customer-call');
    expect(store.forMeeting('grouped')).toEqual({ own: null, group: 'customer-call', effective: 'customer-call' });
    expect(store.forMeeting('loose')!.effective).toBe('general');
    store.setForMeeting('grouped', 'interview');
    expect(store.forMeeting('grouped')).toEqual({ own: 'interview', group: 'customer-call', effective: 'interview' });
    store.setForMeeting('grouped', null);
    expect(store.forMeeting('grouped')!.effective).toBe('customer-call');
    expect(store.groupDefaults()).toEqual({ [group]: 'customer-call' });
    store.setForGroup(group, null);
    expect(store.groupDefaults()).toEqual({});
  });

  it('rejects unknown templates and unknown targets', () => {
    const { store, group } = setup();
    expect(() => store.setForMeeting('loose', 'made-up')).toThrow(/Unknown summary template/);
    expect(() => store.setForGroup(group, 'made-up')).toThrow(/Unknown summary template/);
    expect(() => store.setForMeeting('missing', 'standup')).toThrow(/Meeting not found/);
    expect(() => store.setForGroup('22222222-2222-4222-8222-222222222222', 'standup')).toThrow(/Group not found/);
    expect(store.forMeeting('missing')).toBeNull();
    expect(store.effectiveFor('missing').id).toBe('general');
  });

  it('treats an id this build does not know as inherit', () => {
    const { db, store, group } = setup();
    db.prepare('UPDATE meetings SET summary_template = ? WHERE id = ?').run('from-a-newer-build', 'grouped');
    db.prepare('UPDATE groups SET summary_template = ? WHERE id = ?').run('standup', group);
    expect(store.forMeeting('grouped')).toEqual({ own: null, group: 'standup', effective: 'standup' });
  });
});
