import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PipelineContext } from '../pipeline/context.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import { mergeTranscriptWithDiarization, mergedToMarkdown } from '../lib/merge-transcript.js';
import { RemoteDiarizationSchema, RemoteTextResultSchema, RemoteTranscriptionSchema } from '../../../shared/remote-contracts.js';
import { canonical, digest } from './client.js';
import { RemoteRepository, type RemoteRun } from './repository.js';
import { RemoteEmbeddings } from './embeddings.js';

const ARTIFACT_FILES = ['summary.md', 'transcript.md', 'transcript.raw.json', 'diarization.json'] as const;
function fileHash(file: string): string | null { return fs.existsSync(file) ? digest(fs.readFileSync(file)) : null; }
export function durableWrite(file: string, bytes: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
interface Journal {
  folder: string; generation: string; databaseBefore: string;
  files: { name: string; before: string | null; after: string }[];
  labels: { label: string; rosterId: string | null; confidence: number }[]; text: { summary: string; actionItems: { text: string; owner: string | null; due_date: string | null }[] } | null;
}
/** Flat-file compatibility adapter: immutable generations + durable write-ahead journal.
 * Replay runs before IPC registration. Files can only be at the captured before or after hash;
 * any third value preserves the edit and enters explicit conflict review. No async yield during publish.
 */
export class RemoteImporter {
  constructor(private repo: RemoteRepository, private ctx: Pick<PipelineContext, 'libraryRoot' | 'meetings' | 'speakers' | 'actionItems' | 'artifactCache' | 'settings'>,
    private afterWrite?: (index: number) => void) {}
  folder(id: string): string {
    const m = this.ctx.meetings.findById(id); if (!m) throw new Error('Meeting not found');
    return meetingFolderPath(this.ctx.libraryRoot, m.slug);
  }
  databaseFingerprint(id: string): string {
    const m = this.ctx.meetings.findById(id);
    return digest(canonical({ meeting: m ? { title: m.title, audioPath: m.audioPath, deletedAt: m.deletedAt } : null,
      revision: this.repo.db.prepare('SELECT revision FROM remote_revisions WHERE meeting_id=?').get(id) ?? null,
      speakers: this.ctx.speakers.listForMeeting(id), items: this.ctx.actionItems.listByMeeting(id) }));
  }
  fingerprint(id: string): string {
    return digest(canonical({ database: this.databaseFingerprint(id), files: ARTIFACT_FILES.map(name => [name, fileHash(path.join(this.folder(id), name))]) }));
  }
  private valid(run: RemoteRun): boolean {
    const current = this.repo.current(run.meetingId), meeting = this.ctx.meetings.findById(run.meetingId);
    return current?.id === run.id && !!meeting && !meeting.deletedAt && !current.deleteRequested;
  }
  stage(run: RemoteRun, manifestDigest: string, artifacts: Record<string, Buffer>): void {
    const folder = this.folder(run.meetingId), generation = path.join(folder, '.remote-generations', run.id);
    // Keep original validated bytes as immutable conflict-review evidence.
    fs.mkdirSync(generation, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of Object.entries(artifacts)) {
      if (!['transcription', 'diarization', 'text'].includes(name)) throw new Error('Invalid artifact name');
      const target = path.join(generation, `${name}.json`);
      if (fs.existsSync(target) && fileHash(target) !== digest(bytes)) throw new Error('Immutable generation changed');
      if (!fs.existsSync(target)) durableWrite(target, bytes);
    }
    this.repo.patch(run.id, { manifestDigest, phase: 'downloaded' });
  }
  publish(runId: string, review = false): { status: 'imported' | 'conflict' | 'already-imported' } {
    const run = this.repo.get(runId)!;
    const imported = this.repo.db.prepare('SELECT state FROM remote_imports WHERE run_id=?').get(runId) as { state: string } | undefined;
    if (imported?.state === 'committed') return { status: 'already-imported' };
    if (!this.valid(run) || (!review && this.fingerprint(run.meetingId) !== run.expected)) return this.conflict(run);
    const folder = this.folder(run.meetingId), generation = path.join(folder, '.remote-generations', run.id);
    const outputs: Record<string, string> = {}; let labels: Journal['labels'] = []; let text: Journal['text'] = null;
    if (run.kind === 'audio_analysis') {
      const transcription = RemoteTranscriptionSchema.parse(JSON.parse(fs.readFileSync(path.join(generation, 'transcription.json'), 'utf8')));
      const diar = RemoteDiarizationSchema.parse(JSON.parse(fs.readFileSync(path.join(generation, 'diarization.json'), 'utf8')));
      // Zero vectors never gain an identity, even if a server omitted its warning.
      for (const segment of diar.segments) if (!segment.embedding.some(x => x !== 0)) { segment.speaker = 'unknown'; segment.embedding = []; }
      const embeddings = new RemoteEmbeddings(this.repo.db);
      labels = [...new Set(diar.segments.map(s => s.speaker))].map(label => {
        const match = embeddings.match(diar, label);
        return { label, rosterId: match?.id ?? null, confidence: match?.confidence ?? 0 };
      });
      const names: Record<string, string> = {};
      for (const link of labels) if (link.rosterId) { const speaker = this.ctx.speakers.findById(link.rosterId); if (speaker) names[link.label] = speaker.displayName; }
      // Cluster labels belong only to this analysis. Prior manual assignments
      // may carry forward through verified roster embeddings, never label equality.
      outputs['transcript.raw.json'] = JSON.stringify(transcription);
      outputs['diarization.json'] = JSON.stringify(diar);
      outputs['transcript.md'] = mergedToMarkdown(mergeTranscriptWithDiarization(transcription.segments, diar.segments), names);
    } else {
      text = RemoteTextResultSchema.parse(JSON.parse(fs.readFileSync(path.join(generation, 'text.json'), 'utf8')));
      outputs['summary.md'] = text.summary;
    }
    const journal: Journal = { folder, generation, databaseBefore: this.databaseFingerprint(run.meetingId), files: [], labels, text };
    durableWrite(path.join(generation, 'previous-database.json'), JSON.stringify({ speakers: this.ctx.speakers.listForMeeting(run.meetingId), actionItems: this.ctx.actionItems.listByMeeting(run.meetingId) }));
    for (const [name, content] of Object.entries(outputs)) {
      const before = fileHash(path.join(folder, name));
      // Review/replacement preserves the displaced local version for inspection.
      if (before !== null) durableWrite(path.join(generation, `previous-${name}`), fs.readFileSync(path.join(folder, name)));
      durableWrite(path.join(generation, `publish-${name}`), content);
      journal.files.push({ name, before, after: digest(content) });
    }
    this.repo.db.prepare("INSERT INTO remote_imports VALUES (?,?,'prepared',?) ON CONFLICT(run_id) DO UPDATE SET journal=excluded.journal,state='prepared'")
      .run(run.id, run.manifestDigest, JSON.stringify(journal));
    return this.replayOne(run, journal);
  }
  private conflict(run: RemoteRun): { status: 'conflict' } {
    this.repo.patch(run.id, { phase: 'conflict', error: 'Local content changed. Review the remote result before replacing anything.' });
    return { status: 'conflict' };
  }
  private replayOne(run: RemoteRun, journal: Journal): { status: 'imported' | 'conflict' } {
    if (!this.valid(run) || this.databaseFingerprint(run.meetingId) !== journal.databaseBefore || journal.files.some(f => {
      const hash = fileHash(path.join(journal.folder, f.name)); return hash !== f.before && hash !== f.after;
    })) {
      // Roll back only our own unchanged writes, never a post-crash edit or files
      // now owned by a newer run. This prevents a partially published generation
      // becoming the flat-reader view when replay must park for review.
      if (this.valid(run)) for (const f of journal.files) {
        const target = path.join(journal.folder, f.name);
        if (f.before === f.after || fileHash(target) !== f.after) continue;
        this.ctx.artifactCache.invalidate(target);
        if (f.before === null) fs.unlinkSync(target);
        else {
          const old = fs.readFileSync(path.join(journal.generation, `previous-${f.name}`));
          if (digest(old) === f.before) durableWrite(target, old);
        }
      }
      return this.conflict(run);
    }
    for (const [index, f] of journal.files.entries()) {
      const bytes = fs.readFileSync(path.join(journal.generation, `publish-${f.name}`));
      if (digest(bytes) !== f.after) throw new Error('Import generation integrity check failed');
      this.ctx.artifactCache.invalidate(path.join(journal.folder, f.name));
      if (fileHash(path.join(journal.folder, f.name)) !== f.after) durableWrite(path.join(journal.folder, f.name), bytes);
      this.afterWrite?.(index);
    }
    this.repo.db.transaction(() => {
      if (journal.text) {
        this.ctx.actionItems.deleteForMeeting(run.meetingId);
        for (const item of journal.text.actionItems) this.ctx.actionItems.create(run.meetingId, { text: item.text, ownerName: item.owner, dueDate: item.due_date });
        this.ctx.meetings.updateStage(run.meetingId, 'done'); this.ctx.meetings.updateStatus(run.meetingId, 'done');
      } else {
        // The journal's previous-database/previous-diarization files preserve
        // displaced generation-specific assignments. Replace only active links,
        // atomically and behind the revision fence; roster vectors/history remain.
        this.ctx.speakers.unlinkMeeting(run.meetingId);
        for (const link of journal.labels) this.ctx.speakers.linkToMeeting(run.meetingId, link.label, link.rosterId, link.confidence);
        this.ctx.meetings.updateStage(run.meetingId, 'awaiting_speaker_id'); this.ctx.meetings.updateStatus(run.meetingId, 'awaiting_user');
      }
      this.repo.db.prepare("UPDATE remote_imports SET state='committed' WHERE run_id=?").run(run.id);
      this.repo.patch(run.id, { phase: journal.text ? 'done' : 'needs_speaker_names', error: null });
    })();
    return { status: 'imported' };
  }
  replay(): void {
    const rows = this.repo.db.prepare("SELECT run_id,journal FROM remote_imports WHERE state='prepared'").all() as { run_id: string; journal: string }[];
    for (const row of rows) { const run = this.repo.get(row.run_id); if (run) this.replayOne(run, JSON.parse(row.journal)); }
  }
  review(meetingId: string): { runId: string; kind: string; summary: string | null; generation: string; localFingerprint: string } {
    const run = this.repo.current(meetingId); if (!run || run.phase !== 'conflict') throw new Error('No remote conflict to review');
    const generation = path.join(this.folder(meetingId), '.remote-generations', run.id);
    let summary: string | null = null;
    if (run.kind === 'text_generation') {
      const text = RemoteTextResultSchema.parse(JSON.parse(fs.readFileSync(path.join(generation, 'text.json'), 'utf8')));
      summary = `${text.summary}\n\nExtracted action items:\n${text.actionItems.map(i => `${i.text} — ${i.owner ?? 'Unassigned'} — ${i.due_date ?? 'No date'}`).join('\n')}`;
    } else {
      const transcription = RemoteTranscriptionSchema.parse(JSON.parse(fs.readFileSync(path.join(generation, 'transcription.json'), 'utf8')));
      summary = transcription.segments.map(s => `[${s.start.toFixed(1)}s] ${s.text}`).join('\n');
    }
    return { runId: run.id, kind: run.kind, summary, generation, localFingerprint: this.fingerprint(meetingId) };
  }
}
