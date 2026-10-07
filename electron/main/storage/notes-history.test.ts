import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './db.js';
import { MeetingsRepo } from './meetings-repo.js';
import { ActionItemsRepo } from './action-items-repo.js';
import { SpeakersRepo } from './speakers-repo.js';
import { TerminologyRepo } from './terminology-repo.js';
import { TerminologyService } from '../terminology/service.js';
import { ArtifactCache } from '../library/artifact-cache.js';
import { NotesHistory } from './notes-history.js';

let root: string, db: ReturnType<typeof openDb>, meetings: MeetingsRepo, items: ActionItemsRepo, history: NotesHistory, terms: TerminologyService;
const file = (name: string) => path.join(root, 'meetings', 'm', name);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-history-')); db = openDb(path.join(root,'db.sqlite'));
  meetings = new MeetingsRepo(db); items = new ActionItemsRepo(db);
  meetings.insert({id: 'm',slug: 'm',title: 'Meeting',startedAt: null,durationS: 30,audioPath: '/fixture',status: 'done',pipelineStage: 'done'});
  fs.mkdirSync(path.dirname(file('summary.md')), {recursive: true}); fs.writeFileSync(file('summary.md'), 'Original notes'); fs.writeFileSync(file('transcript.md'), 'Transcript');
  terms = new TerminologyService(new TerminologyRepo(db), {libraryRoot: root, meetings, speakers: new SpeakersRepo(db), artifactCache: new ArtifactCache(), userName: () => '', beforeSummaryChange: id => history.capture(id, 'Before edit')});
  history = new NotesHistory(db, {libraryRoot: root, meetings, items, terminology: terms});
  items.create('m',{text: 'Original task',ownerName: 'Dan',dueDate: '2026-10-06'});
  const task = items.listByMeeting('m')[0]!; items.setStatus(task.id, 'done'); items.markExported(task.id,'apple');
});
afterEach(() => {vi.restoreAllMocks(); db.close(); fs.rmSync(root,{recursive: true,force: true});});
it('restores notes and all canonical task fields, saving the replaced version', () => {
  const original = items.listByMeeting('m'); terms.saveSummary('m', 'New notes');
  const version = history.list('m')[0]!; items.deleteForMeeting('m'); items.create('m',{text: 'New task',ownerName: null,dueDate: null});
  const compare = history.compare('m',version.id);
  expect(compare.previous.summary).toBe('Original notes'); expect(compare.current.summary).toBe('New notes');
  history.restore('m',version.id,compare.revision);
  expect(fs.readFileSync(file('summary.md'),'utf8')).toBe('Original notes');
  expect(items.listByMeeting('m')).toEqual(original);
  expect(history.list('m')).toHaveLength(2);
  expect(history.compare('m',history.list('m')[0]!.id).previous.summary).toBe('New notes');
});
it('rejects stale comparisons, processing, missing versions and cross-meeting IDs', () => {
  history.capture('m','Before regenerate'); const version = history.list('m')[0]!;
  const compare = history.compare('m',version.id); items.update(items.listByMeeting('m')[0]!.id,{text: 'Edited after compare'});
  expect(() => history.restore('m',version.id,compare.revision)).toThrow('changed');
  meetings.updateStatus('m','processing'); expect(() => history.restore('m',version.id,history.revision('m'))).toThrow('processing');
  expect(() => history.compare('m','missing')).toThrow('no longer available');
});
it('deduplicates consecutive versions and bounds retention at twenty', () => {
  history.capture('m','First'); history.capture('m','Duplicate'); expect(history.list('m')).toHaveLength(1);
  for (let i=0;i<25;i++) terms.saveSummary('m', `Notes ${i}`);
  expect(history.list('m')).toHaveLength(20);
  expect(history.compare('m',history.list('m')[0]!.id).previous.summary).toBe('Notes 23');
});
it('marks restored notes stale if the transcript changed', () => {
  terms.saveSummary('m','New notes'); const version = history.list('m')[0]!;
  fs.writeFileSync(file('transcript.md'), 'Corrected transcript');
  history.restore('m',version.id,history.revision('m')); expect(terms.stale('m')).toBe(true);
});
it('recovers an interrupted restore after the notes file was written', () => {
  terms.saveSummary('m','New notes'); const version = history.list('m')[0]!; items.deleteForMeeting('m');
  const originalRestore = terms.restoreSummary.bind(terms);
  vi.spyOn(terms,'restoreSummary').mockImplementation((...args) => {originalRestore(...args); throw new Error('Crash after file');});
  expect(() => history.restore('m',version.id,history.revision('m'))).toThrow('Crash');
  expect(db.prepare('SELECT COUNT(*) AS n FROM notes_restore_pending').get()).toEqual({n: 1});
  vi.restoreAllMocks(); history.recover();
  expect(items.listByMeeting('m')[0]!.text).toBe('Original task');
  expect(db.prepare('SELECT COUNT(*) AS n FROM notes_restore_pending').get()).toEqual({n: 0});
});
it('never overwrites intervening edits during crash recovery and allows fresh explicit restore', () => {
  terms.saveSummary('m','New notes'); const version = history.list('m')[0]!;
  vi.spyOn(terms,'restoreSummary').mockImplementation(() => {throw new Error('Crash before file');});
  expect(() => history.restore('m',version.id,history.revision('m'))).toThrow('Crash'); vi.restoreAllMocks();
  fs.writeFileSync(file('summary.md'), 'External edit');
  expect(() => history.recover()).toThrow('Nothing was overwritten'); expect(fs.readFileSync(file('summary.md'),'utf8')).toBe('External edit');
  history.restore('m',version.id,history.compare('m',version.id).revision);
  expect(fs.readFileSync(file('summary.md'),'utf8')).toBe('Original notes');
});
