import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../storage/db.js';
import { TerminologyRepo } from '../storage/terminology-repo.js';
import { TerminologyService } from './service.js';
import { MeetingsRepo } from '../storage/meetings-repo.js';
import { GroupsRepo } from '../storage/groups-repo.js';
import { SpeakersRepo } from '../storage/speakers-repo.js';
import { ArtifactCache } from '../library/artifact-cache.js';
import type { TermInput } from '../../shared/terminology.js';

let db: Database.Database,
  root: string,
  repo: TerminologyRepo,
  service: TerminologyService,
  meetings: MeetingsRepo,
  groups: GroupsRepo,
  cache: ArtifactCache,
  speakers: SpeakersRepo;
const input: TermInput = {
  source: 'Salsa',
  replacement: 'SLSA',
  groupId: null,
  mode: 'suggest',
  enabled: true,
  caseSensitive: false,
};
const file = (name: string) => path.join(root, 'meetings', 'm', name);
function raw(text = 'We discussed Salsa compliance. Salsa is important.'): void {
  fs.writeFileSync(
    file('transcript.raw.json'),
    JSON.stringify({ segments: [{ start: 10, end: 20, text }] }),
  );
}
function setupService(): TerminologyService {
  return new TerminologyService(repo, {
    libraryRoot: root,
    meetings,
    speakers,
    artifactCache: cache,
    userName: () => '',
  });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-terms-'));
  db = openDb(path.join(root, 'db.sqlite'));
  repo = new TerminologyRepo(db);
  meetings = new MeetingsRepo(db);
  groups = new GroupsRepo(db);
  speakers = new SpeakersRepo(db);
  cache = new ArtifactCache();
  meetings.insert({
    id: 'm',
    slug: 'm',
    title: 'Meeting',
    startedAt: null,
    durationS: 30,
    audioPath: '/fixture.wav',
    status: 'done',
    pipelineStage: 'done',
  });
  fs.mkdirSync(path.dirname(file('transcript.md')), { recursive: true });
  raw();
  fs.writeFileSync(
    file('diarization.json'),
    JSON.stringify({ segments: [{ start: 0, end: 30, speaker: 'SPEAKER_00' }] }),
  );
  service = setupService();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('terminology dictionary', () => {
  it('isolates group scope, gives suggest overrides precedence, and deletes group rules safely', () => {
    const g = groups.create('Engineering');
    repo.save({ ...input, mode: 'automatic' });
    repo.save({ ...input, groupId: g.id });
    expect(repo.applicable(g.id)).toHaveLength(1);
    expect(repo.applicable(g.id)[0]!.mode).toBe('suggest');
    expect(repo.applicable(null)[0]!.mode).toBe('automatic');
    groups.delete(g.id);
    expect(repo.list()).toHaveLength(1);
    expect(repo.list()[0]!.groupId).toBe(null);
  });
  it('rejects duplicates, invalid input and cycles including group overrides', () => {
    const saved = repo.save(input);
    expect(() => repo.save(input)).toThrow('already exists');
    expect(() => repo.save({ ...input, source: '' })).toThrow();
    expect(() => repo.save({ ...input, source: 'SLSA', replacement: 'Salsa' })).toThrow('cycle');
    expect(repo.save({ ...input, replacement: 'SLSA framework' }, saved.id).revision).toBe(2);
    repo.offers(false);
    expect(new TerminologyRepo(db).offers()).toBe(false);
  });
});
describe('terminology documents', () => {
  it('undoes one occurrence in repeated identical prose without guessing after later edits', () => {
    repo.save(input);
    const paragraph = 'This repeated paragraph mentions Salsa and has a long identical ending.\n';
    fs.writeFileSync(file('summary.md'), paragraph.repeat(4));
    const p = service.preview({ meetingId: 'm', artifact: 'summary' });
    const applied = service.commit({
      meetingId: 'm',
      artifact: 'summary',
      revision: p.revision,
      keys: p.matches.map((m) => m.key),
    });
    service.undo('m', 'summary', applied.history[1]!.id, applied.revision);
    expect(fs.readFileSync(file('summary.md'), 'utf8').match(/Salsa/g)).toHaveLength(1);
  });
  it('retains the dictionary and applied corrections after reopening the library database', () => {
    repo.save({ ...input, mode: 'automatic' });
    service.generateTranscript('m', true);
    db.close();
    db = openDb(path.join(root, 'db.sqlite'));
    repo = new TerminologyRepo(db);
    meetings = new MeetingsRepo(db);
    speakers = new SpeakersRepo(db);
    service = setupService();
    expect(repo.list()[0]!.replacement).toBe('SLSA');
    expect(service.preview({ meetingId: 'm', artifact: 'transcript' }).history).toHaveLength(2);
    service.generateTranscript('m', false);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('SLSA');
  });
  it('does not overwrite transcript edits made outside the correction workflow', () => {
    service.generateTranscript('m', true);
    fs.writeFileSync(file('transcript.md'), '[Dan 00:10] External edits');
    expect(() => service.generateTranscript('m', false)).toThrow('edited outside');
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('External edits');
  });
  it('does not apply a group suggestion automatically through a library automatic rule', () => {
    const g = groups.create('Engineering');
    groups.assign(['m'], g.id);
    repo.save({ ...input, mode: 'automatic' });
    repo.save({ ...input, groupId: g.id });
    service.generateTranscript('m', true);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('Salsa');
    expect(service.snapshotSummary('m').rules).toHaveLength(0);
  });
  it('suggests without rewriting, applies selected occurrences, survives speaker remerge and preserves raw timing', async () => {
    repo.save(input);
    const original = fs.readFileSync(file('transcript.raw.json'), 'utf8');
    service.generateTranscript('m', true);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('Salsa');
    const p = service.preview({ meetingId: 'm', artifact: 'transcript' });
    expect(p.matches).toHaveLength(2);
    await cache.readText(file('transcript.md'));
    service.commit({
      meetingId: 'm',
      artifact: 'transcript',
      revision: p.revision,
      keys: [p.matches[0]!.key],
    });
    expect(service.stale('m')).toBe(true);
    expect(await cache.readText(file('transcript.md'))).toContain('SLSA compliance. Salsa');
    vi.spyOn(speakers, 'listForMeeting').mockReturnValue([
      { localLabel: 'SPEAKER_00', displayName: 'Dan' },
    ] as ReturnType<SpeakersRepo['listForMeeting']>);
    setupService().generateTranscript('m', false);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toBe(
      '[Dan 00:10] We discussed SLSA compliance. Salsa is important.',
    );
    expect(fs.readFileSync(file('transcript.raw.json'), 'utf8')).toBe(original);
  });
  it('automatically applies scoped rules; changes and moving a meeting never retroactively rewrite it', () => {
    const g = groups.create('Engineering');
    groups.assign(['m'], g.id);
    const r = repo.save({ ...input, groupId: g.id, mode: 'automatic' });
    service.generateTranscript('m', true);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('SLSA');
    repo.save({ ...r, replacement: 'Other' }, r.id);
    groups.assign(['m'], null);
    service.generateTranscript('m', false);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('SLSA');
    raw('New Salsa recording.');
    service.generateTranscript('m', true);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('New Salsa');
    expect(service.preview({ meetingId: 'm', artifact: 'transcript' }).previousCorrections).toBe(
      true,
    );
  });
  it('rejects stale previews, persists dismissals per revision, and excludes suggest rules from prompts', () => {
    const r = repo.save(input);
    service.generateTranscript('m', true);
    const p = service.preview({ meetingId: 'm', artifact: 'transcript' });
    expect(service.snapshotSummary('m').glossary).toBe('[]');
    repo.save({ ...r, replacement: 'Security' }, r.id);
    expect(() =>
      service.commit({
        meetingId: 'm',
        artifact: 'transcript',
        revision: p.revision,
        keys: [p.matches[0]!.key],
      }),
    ).toThrow('changed');
    const next = service.preview({ meetingId: 'm', artifact: 'transcript' });
    service.commit({
      meetingId: 'm',
      artifact: 'transcript',
      revision: next.revision,
      keys: next.matches.map((m) => m.key),
      dismiss: true,
    });
    expect(setupService().preview({ meetingId: 'm', artifact: 'transcript' }).matches).toHaveLength(
      0,
    );
  });
  it('undoes an automatic occurrence and does not reapply on speaker remerge', () => {
    repo.save({ ...input, mode: 'automatic' });
    service.generateTranscript('m', true);
    const p = service.preview({ meetingId: 'm', artifact: 'transcript' });
    service.undo('m', 'transcript', p.history[0]!.id, p.revision);
    const text = fs.readFileSync(file('transcript.md'), 'utf8');
    expect(text).toContain('Salsa');
    service.generateTranscript('m', false);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toBe(text);
    const next = service.preview({ meetingId: 'm', artifact: 'transcript' });
    const other = next.history.find((h) => !h.undone)!;
    service.undo('m', 'transcript', other.id, next.revision);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).not.toContain('SLSA');
  });
  it('preserves unrelated summary edits on undo and rejects overlapping edits', () => {
    repo.save(input);
    fs.writeFileSync(
      file('summary.md'),
      'Salsa is the discussed standard.\n\nUnrelated original notes.',
    );
    let p = service.preview({ meetingId: 'm', artifact: 'summary' });
    service.commit({
      meetingId: 'm',
      artifact: 'summary',
      revision: p.revision,
      keys: p.matches.map((m) => m.key),
    });
    service.saveSummary('m', 'SLSA is the discussed standard.\n\nUnrelated edited notes.');
    p = service.preview({ meetingId: 'm', artifact: 'summary' });
    service.undo('m', 'summary', p.history[0]!.id, p.revision);
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toContain('Unrelated edited notes.');
    p = service.preview({ meetingId: 'm', artifact: 'summary' });
    service.commit({
      meetingId: 'm',
      artifact: 'summary',
      revision: p.revision,
      keys: p.matches.map((m) => m.key),
    });
    service.saveSummary('m', 'A different standard is discussed.');
    p = service.preview({ meetingId: 'm', artifact: 'summary' });
    expect(() =>
      service.undo('m', 'summary', p.history.find((h) => !h.undone)!.id, p.revision),
    ).toThrow('passage has changed');
  });
  it('uses a generation snapshot and guards manual summary edits during generation', () => {
    const r = repo.save({ ...input, mode: 'automatic' });
    service.generateTranscript('m', true);
    const s = service.snapshotSummary('m');
    repo.save({ ...r, replacement: 'Other' }, r.id);
    expect(service.generateSummary('m', '## Overview\nSalsa compliance.', s)).toContain('SLSA');
    expect(service.stale('m')).toBe(false);
    const next = service.snapshotSummary('m');
    service.saveSummary('m', 'My edits');
    expect(() => service.generateSummary('m', 'Salsa', next)).toThrow('changed during');
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toBe('My edits');
  });
  it('recovers an interrupted write without clobbering intervening manual edits', () => {
    fs.writeFileSync(file('summary.md'), 'Before');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    expect(() => service.saveSummary('m', 'After')).toThrow('disk unavailable');
    expect(repo.pending()).toHaveLength(1);
    rename.mockRestore();
    setupService().recover();
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toBe('After');
    expect(repo.pending()).toHaveLength(0);
    const fail = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    expect(() => service.saveSummary('m', 'New')).toThrow();
    fail.mockRestore();
    fs.writeFileSync(file('summary.md'), 'Manual change');
    setupService().recover();
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toBe('Manual change');
  });
});
