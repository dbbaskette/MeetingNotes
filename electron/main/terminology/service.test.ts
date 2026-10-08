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

describe('meeting-wide terminology corrections', () => {
  const target = {
    meetingId: 'm',
    artifact: 'meeting' as const,
    source: 'Salsa',
    replacement: 'SLSA',
  };
  const preview = () => service.preview(target);
  const commit = () => {
    const p = preview();
    return service.commit({ ...target, revision: p.revision, keys: p.matches.map((m) => m.key) });
  };
  beforeEach(() => {
    service.generateTranscript('m', false);
    fs.writeFileSync(file('summary.md'), '## Overview\nSalsa compliance.\n\nMy custom notes.');
  });
  it('previews both documents, applies once and groups Undo without changing raw data', async () => {
    const rawBefore = fs.readFileSync(file('transcript.raw.json'), 'utf8');
    const diarBefore = fs.readFileSync(file('diarization.json'), 'utf8');
    await cache.readText(file('summary.md'));
    const p = preview();
    expect(p.matches.filter((m) => m.artifact === 'transcript')).toHaveLength(2);
    expect(p.matches.filter((m) => m.artifact === 'summary')).toHaveLength(1);
    expect(new Set(p.matches.map((m) => m.key)).size).toBe(3);
    const applied = commit();
    expect(applied.history).toHaveLength(3);
    expect(new Set(applied.history.map((h) => h.batchId)).size).toBe(1);
    expect(await cache.readText(file('summary.md'))).toContain('SLSA compliance.');
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).not.toContain('Salsa');
    expect(service.stale('m')).toBe(false);
    expect(repo.list()).toHaveLength(0); // Apply is not permission to remember.
    service.undoMeeting('m', applied.history[0]!.id, applied.revision);
    expect(preview().matches).toHaveLength(3);
    expect(fs.readFileSync(file('transcript.raw.json'), 'utf8')).toBe(rawBefore);
    expect(fs.readFileSync(file('diarization.json'), 'utf8')).toBe(diarBefore);
  });
  it('preserves markup and unrelated manual edits on grouped Undo', () => {
    const summary =
      '## Salsa\n**Salsa** [Salsa](https://example.com/Salsa) `Salsa`\n\nMy custom notes.';
    fs.writeFileSync(file('summary.md'), summary);
    const applied = commit();
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toBe(
      '## SLSA\n**SLSA** [SLSA](https://example.com/Salsa) `Salsa`\n\nMy custom notes.',
    );
    service.saveSummary(
      'm',
      fs
        .readFileSync(file('summary.md'), 'utf8')
        .replace('My custom notes.', 'My updated custom notes.'),
    );
    const current = service.preview({ meetingId: 'm', artifact: 'meeting' });
    service.undoMeeting('m', applied.history[0]!.id, current.revision);
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toBe(
      summary.replace('My custom notes.', 'My updated custom notes.'),
    );
  });
  it('refuses Undo for both documents when one corrected passage has changed', () => {
    const applied = commit();
    const transcript = fs.readFileSync(file('transcript.md'), 'utf8');
    service.saveSummary('m', 'A different standard.');
    const current = service.preview({ meetingId: 'm', artifact: 'meeting' });
    expect(() => service.undoMeeting('m', applied.history[0]!.id, current.revision)).toThrow(
      'passage has changed',
    );
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toBe(transcript);
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toBe('A different standard.');
  });
  it('checks both document revisions and dictionary revisions before writing', () => {
    const p = preview();
    fs.writeFileSync(file('summary.md'), 'My newer Salsa notes.');
    expect(() =>
      service.commit({ ...target, revision: p.revision, keys: p.matches.map((m) => m.key) }),
    ).toThrow('changed');
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('Salsa');
    const next = preview();
    repo.save(input);
    expect(() =>
      service.commit({ ...target, revision: next.revision, keys: next.matches.map((m) => m.key) }),
    ).toThrow('changed');
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toBe('My newer Salsa notes.');
  });
  it('refuses a partial Undo when one document has been removed', () => {
    const applied = commit();
    fs.unlinkSync(file('summary.md'));
    const current = service.preview({ meetingId: 'm', artifact: 'meeting' });
    expect(() => service.undoMeeting('m', applied.history[0]!.id, current.revision)).toThrow(
      'history changed',
    );
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).not.toContain('Salsa');
    expect(fs.existsSync(file('summary.md'))).toBe(false);
  });
  it('refuses a partial Undo after notes regeneration has replaced correction history', () => {
    const applied = commit();
    service.generateSummary('m', 'My regenerated SLSA notes.', service.snapshotSummary('m'));
    const current = service.preview({ meetingId: 'm', artifact: 'meeting' });
    expect(() => service.undoMeeting('m', applied.history[0]!.id, current.revision)).toThrow(
      'history changed',
    );
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).not.toContain('Salsa');
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toBe('My regenerated SLSA notes.');
  });
  it('preserves a pre-existing stale flag', () => {
    const p = service.preview({ ...target, artifact: 'transcript' });
    service.commit({
      ...target,
      artifact: 'transcript',
      revision: p.revision,
      keys: [p.matches[0]!.key],
    });
    commit();
    expect(service.stale('m')).toBe(true);
  });
  it('marks notes stale when summary matches are deliberately left unchanged', () => {
    const p = preview();
    service.commit({
      ...target,
      revision: p.revision,
      keys: p.matches.filter((m) => m.artifact === 'transcript').map((m) => m.key),
    });
    expect(service.stale('m')).toBe(true);
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toContain('Salsa');
  });
  it('works with a summary-only meeting and no raw transcript', () => {
    fs.unlinkSync(file('transcript.md'));
    fs.unlinkSync(file('transcript.raw.json'));
    const applied = commit();
    expect(applied.history).toHaveLength(1);
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toContain('SLSA');
    service.undoMeeting('m', applied.history[0]!.id, applied.revision);
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toContain('Salsa');
  });
  it('uses group overrides across both documents and persists dismissals', () => {
    const g = groups.create('Engineering');
    groups.assign(['m'], g.id);
    repo.save({ ...input, replacement: 'Other' });
    repo.save({ ...input, groupId: g.id });
    const p = service.preview({ meetingId: 'm', artifact: 'meeting' });
    expect(p.matches.every((m) => m.after === 'SLSA')).toBe(true);
    service.commit({
      meetingId: 'm',
      artifact: 'meeting',
      revision: p.revision,
      keys: p.matches.map((m) => m.key),
      dismiss: true,
    });
    expect(setupService().preview({ meetingId: 'm', artifact: 'meeting' }).matches).toHaveLength(0);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('Salsa');
  });
  it('rejects invalid selections and edits during processing without changing either file', () => {
    const p = preview();
    expect(() =>
      service.commit({
        ...target,
        revision: p.revision,
        keys: [p.matches[0]!.key, 'summary/invalid'],
      }),
    ).toThrow('valid occurrences');
    meetings.updateStatus('m', 'processing');
    expect(() => commit()).toThrow('processing');
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('Salsa');
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toContain('Salsa');
  });
  it('rolls back the first file and history when the second write fails', () => {
    const rename = fs.renameSync;
    let failed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === file('summary.md') && !failed) {
        failed = true;
        throw new Error('disk unavailable');
      }
      return rename(from, to);
    });
    expect(() => commit()).toThrow('disk unavailable');
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('Salsa');
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toContain('Salsa');
    expect(repo.pending()).toHaveLength(0);
    expect(preview().history).toHaveLength(0);
  });
  function interrupt(): void {
    const rename = fs.renameSync;
    let writes = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (++writes > 1) throw new Error('disk unavailable');
      return rename(from, to);
    });
    expect(() => commit()).toThrow('disk unavailable');
    expect(repo.pending()).toHaveLength(2);
    vi.restoreAllMocks();
  }
  it('recovers both documents and grouped history after an interrupted batch', () => {
    interrupt();
    service = setupService();
    service.recover();
    expect(repo.pending()).toHaveLength(0);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).not.toContain('Salsa');
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toContain('SLSA');
    expect(preview().history).toHaveLength(3);
  });
  it('rolls back its partial write if recovery finds an external edit to the other file', () => {
    interrupt();
    fs.writeFileSync(file('summary.md'), 'External edits must survive.');
    setupService().recover();
    expect(repo.pending()).toHaveLength(0);
    expect(fs.readFileSync(file('transcript.md'), 'utf8')).toContain('Salsa');
    expect(fs.readFileSync(file('summary.md'), 'utf8')).toBe('External edits must survive.');
    expect(preview().history).toHaveLength(0);
  });
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
