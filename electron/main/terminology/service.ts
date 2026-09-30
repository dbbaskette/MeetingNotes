import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { findTerms } from '../../shared/terminology-matcher.js';
import type {
  TermArtifact,
  TermCommitInput,
  TermHistory,
  TermMatch,
  TermPreviewInput,
  TermReview,
  TermRule,
} from '../../shared/terminology.js';
import { type TerminologyRepo, TermInputSchema } from '../storage/terminology-repo.js';
import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { SpeakersRepo } from '../storage/speakers-repo.js';
import type { ArtifactCache } from '../library/artifact-cache.js';
import { meetingFolderPath } from '../storage/meeting-folder.js';
import {
  mergeTranscriptWithDiarization,
  mergedToMarkdown,
  type WhisperSegment,
  type DiarSegment,
} from '../lib/merge-transcript.js';
import { VOICE_SPEAKER_LABEL } from '../lib/stem-paths.js';

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
interface Edit extends TermHistory {
  left: string;
  right: string;
  unitRevision?: string;
}
interface Document {
  rawRevision: string;
  units: string[];
  history: Edit[];
  dismissed: string[];
  stale: boolean;
  previousCorrections: boolean;
  outputRevision?: string;
}
interface Pending {
  before: string;
  output: string;
  next: Document;
  previous?: Document;
}
const fresh = (units: string[], rawRevision = ''): Document => ({
  rawRevision,
  units,
  history: [],
  dismissed: [],
  stale: false,
  previousCorrections: false,
});
export interface SummaryTerms {
  rules: TermRule[];
  glossary: string;
  transcriptRevision: string;
  summaryRevision: string;
}

export class TerminologyService {
  constructor(
    readonly repo: TerminologyRepo,
    private readonly deps: {
      libraryRoot: string;
      meetings: MeetingsRepo;
      speakers: SpeakersRepo;
      artifactCache: ArtifactCache;
      userName: () => string;
    },
  ) {}

  private meeting(id: string) {
    const m = this.deps.meetings.findById(id);
    if (!m || m.deletedAt) throw new Error('Meeting no longer exists');
    return m;
  }
  private file(id: string, artifact: TermArtifact): string {
    return path.join(
      meetingFolderPath(this.deps.libraryRoot, this.meeting(id).slug),
      `${artifact}.md`,
    );
  }
  private text(file: string): string {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    }
  }
  private raw(id: string): { segments: WhisperSegment[]; revision: string } {
    const text = this.text(
      path.join(path.dirname(this.file(id, 'transcript')), 'transcript.raw.json'),
    );
    if (!text) throw new Error('Wait for transcription to finish before correcting terms');
    return {
      segments: (JSON.parse(text) as { segments: WhisperSegment[] }).segments,
      revision: hash(text),
    };
  }
  private render(id: string, doc: Document): string {
    const raw = this.raw(id);
    if (raw.revision !== doc.rawRevision)
      throw new Error('Transcript changed. Reopen the correction preview.');
    const diarText = this.text(
      path.join(path.dirname(this.file(id, 'transcript')), 'diarization.json'),
    );
    const diar = diarText ? (JSON.parse(diarText) as { segments: DiarSegment[] }).segments : [];
    const labels: Record<string, string> = {
      [VOICE_SPEAKER_LABEL]: this.deps.userName().trim() || 'You',
    };
    for (const speaker of this.deps.speakers.listForMeeting(id))
      if (speaker.displayName) labels[speaker.localLabel] = speaker.displayName;
    return mergedToMarkdown(
      mergeTranscriptWithDiarization(
        raw.segments.map((s, i) => ({ ...s, text: doc.units[i] ?? s.text })),
        diar,
      ),
      labels,
    );
  }

  /** SQLite records the intention before atomic rename; restart can finish it
   * only when the on-disk fingerprint still agrees. Never overwrite new edits. */
  private persist(id: string, artifact: TermArtifact, doc: Document, output: string): void {
    const file = this.file(id, artifact);
    const previous = this.repo.read<Document>(id, artifact);
    doc.outputRevision = hash(output);
    const pending: Pending = { before: hash(this.text(file)), output, next: doc, previous };
    this.repo.write(id, artifact, previous ?? fresh([]), pending);
    const temp = `${file}.terminology-${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, output);
      fs.renameSync(temp, file);
      this.deps.artifactCache.invalidate(file);
      this.repo.write(id, artifact, doc);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  recover(): void {
    for (const row of this.repo.pending()) {
      const meeting = this.deps.meetings.findById(row.meeting_id);
      if (!meeting || meeting.deletedAt) continue;
      const pending = JSON.parse(row.pending_json) as Pending;
      const file = this.file(row.meeting_id, row.artifact);
      const current = hash(this.text(file));
      if (current === hash(pending.output))
        this.repo.write(row.meeting_id, row.artifact, pending.next);
      else if (current === pending.before)
        this.persist(row.meeting_id, row.artifact, pending.next, pending.output);
      else
        this.repo.write(row.meeting_id, row.artifact, {
          ...(pending.previous ?? fresh([])),
          previousCorrections: true,
        });
      this.deps.artifactCache.invalidate(file);
    }
  }
  private document(id: string, artifact: TermArtifact): Document {
    const previous = this.repo.read<Document>(id, artifact);
    if (artifact === 'summary') {
      return { ...(previous ?? fresh([])), units: [this.text(this.file(id, artifact))] };
    }
    const raw = this.raw(id);
    if (previous?.rawRevision === raw.revision) {
      const text = this.text(this.file(id, artifact));
      if (text && previous.outputRevision && hash(text) !== previous.outputRevision)
        throw new Error(
          'This transcript was edited outside the correction workflow. Preserve those edits before regenerating the transcript.',
        );
      return previous;
    }
    return {
      ...fresh(
        raw.segments.map((s) => s.text),
        raw.revision,
      ),
      previousCorrections: Boolean(previous?.history.length),
    };
  }
  private ensureEditable(id: string): void {
    if (this.meeting(id).status === 'processing')
      throw new Error('Wait for processing to finish before changing terminology in this meeting');
  }
  private revision(id: string, artifact: TermArtifact, doc: Document): string {
    return hash(
      JSON.stringify([
        this.text(this.file(id, artifact)),
        doc,
        this.repo.applicable(this.meeting(id).groupId),
      ]),
    );
  }
  private candidates(id: string, doc: Document, input: TermPreviewInput): TermMatch[] {
    let rules = this.repo.applicable(this.meeting(id).groupId);
    if (input.source !== undefined || input.replacement !== undefined) {
      const rule = TermInputSchema.parse({
        source: input.source,
        replacement: input.replacement,
        groupId: null,
        mode: 'suggest',
        caseSensitive: false,
        enabled: true,
      });
      if (rule.source === rule.replacement) throw new Error('Choose a different replacement');
      rules = [{ ...rule, id: 'manual', revision: 1 }];
    }
    return findTerms(doc.units, rules).filter(
      (m) => !doc.dismissed.includes(`${hash(JSON.stringify(doc.units))}:${m.key}`),
    );
  }
  preview(input: TermPreviewInput): TermReview {
    this.recover();
    const doc = this.document(input.meetingId, input.artifact);
    return {
      revision: this.revision(input.meetingId, input.artifact, doc),
      matches: this.candidates(input.meetingId, doc, input),
      history: doc.history.map(({ left: _left, right: _right, ...h }) => h),
      stale: doc.stale,
      previousCorrections: doc.previousCorrections,
    };
  }
  private apply(doc: Document, matches: TermMatch[]): void {
    const byUnit = new Map<number, TermMatch[]>();
    for (const m of matches) {
      const list = byUnit.get(m.unit) ?? [];
      list.push(m);
      byUnit.set(m.unit, list);
    }
    for (const [unit, changes] of byUnit) {
      const original = doc.units[unit]!,
        parts: string[] = [],
        added: Edit[] = [];
      let at = 0,
        shift = 0;
      for (const m of changes.sort((a, b) => a.start - b.start)) {
        if (m.start < at || original.slice(m.start, m.start + m.before.length) !== m.before)
          throw new Error('Correction preview is out of date');
        parts.push(original.slice(at, m.start), m.after);
        added.push({
          ...m,
          start: m.start + shift,
          id: randomUUID(),
          undone: false,
          left: '',
          right: '',
        });
        at = m.start + m.before.length;
        shift += m.after.length - m.before.length;
      }
      parts.push(original.slice(at));
      doc.units[unit] = parts.join('');
      const unitRevision = hash(doc.units[unit]!);
      // Contexts reflect the complete batch, including neighboring replacements.
      for (const h of added) {
        h.unitRevision = unitRevision;
        h.left = doc.units[unit]!.slice(Math.max(0, h.start - 24), h.start);
        h.right = doc.units[unit]!.slice(h.start + h.after.length, h.start + h.after.length + 24);
      }
      doc.history.push(...added);
    }
  }
  commit(input: TermCommitInput): TermReview {
    this.recover();
    this.ensureEditable(input.meetingId);
    const doc = this.document(input.meetingId, input.artifact);
    if (input.revision !== this.revision(input.meetingId, input.artifact, doc))
      throw new Error('The text or dictionary changed. Preview again before applying.');
    const matches = this.candidates(input.meetingId, doc, input).filter((m) =>
      input.keys.includes(m.key),
    );
    if (!matches.length || matches.length !== new Set(input.keys).size)
      throw new Error('Select valid occurrences from the current preview');
    if (input.dismiss) {
      const revision = hash(JSON.stringify(doc.units));
      doc.dismissed.push(...matches.map((m) => `${revision}:${m.key}`));
      doc.dismissed = doc.dismissed.slice(-4000);
      this.repo.write(input.meetingId, input.artifact, doc);
    } else {
      this.apply(doc, matches);
      if (input.artifact === 'transcript') doc.stale = true;
      this.persist(
        input.meetingId,
        input.artifact,
        doc,
        input.artifact === 'transcript' ? this.render(input.meetingId, doc) : doc.units[0]!,
      );
    }
    return this.preview({ meetingId: input.meetingId, artifact: input.artifact });
  }
  undo(id: string, artifact: TermArtifact, historyId: string, revision: string): TermReview {
    this.recover();
    this.ensureEditable(id);
    const doc = this.document(id, artifact);
    if (revision !== this.revision(id, artifact, doc))
      throw new Error('The text changed. Refresh corrections before undoing.');
    const h = doc.history.find((e) => e.id === historyId && !e.undone);
    if (!h) throw new Error('Correction is no longer available to undo');
    const text = doc.units[h.unit]!;
    const unitRevision = hash(text);
    const locate = (edit: Edit): number => {
      if (
        edit.unitRevision === unitRevision &&
        text.slice(edit.start, edit.start + edit.after.length) === edit.after
      )
        return edit.start;
      const needle = edit.left + edit.after + edit.right;
      const index = text.indexOf(needle);
      return index >= 0 && text.indexOf(needle, index + 1) < 0 ? index + edit.left.length : -1;
    };
    const at = locate(h);
    if (at < 0)
      throw new Error('This passage has changed. Correct it manually to preserve your edits.');
    const anchors = new Map<Edit, number>();
    for (const other of doc.history.filter(
      (e) => e.unit === h.unit && !e.undone && e.id !== h.id,
    )) {
      const i = locate(other);
      if (i >= 0) anchors.set(other, i);
    }
    doc.units[h.unit] = text.slice(0, at) + h.before + text.slice(at + h.after.length);
    const nextRevision = hash(doc.units[h.unit]!);
    h.undone = true;
    // Re-anchor other history using unchanged expected text, without guessing
    // if a subsequent edit has made an occurrence ambiguous.
    for (const [other, oldPos] of anchors) {
      const pos = oldPos > at ? oldPos + h.before.length - h.after.length : oldPos;
      const next = doc.units[h.unit]!;
      if (next.slice(pos, pos + other.after.length) === other.after) {
        other.start = pos;
        other.unitRevision = nextRevision;
        other.left = next.slice(Math.max(0, pos - 24), pos);
        other.right = next.slice(pos + other.after.length, pos + other.after.length + 24);
      }
    }
    if (artifact === 'transcript') doc.stale = true;
    this.persist(
      id,
      artifact,
      doc,
      artifact === 'transcript' ? this.render(id, doc) : doc.units[0]!,
    );
    return this.preview({ meetingId: id, artifact });
  }
  generateTranscript(id: string, automatic: boolean): { segments: number; named: number } {
    this.recover();
    const raw = this.raw(id),
      previous = this.repo.read<Document>(id, 'transcript');
    const doc = this.document(id, 'transcript');
    if (automatic && previous?.rawRevision !== raw.revision) {
      this.apply(
        doc,
        findTerms(
          doc.units,
          this.repo.applicable(this.meeting(id).groupId).filter((r) => r.mode === 'automatic'),
          100_000,
        ),
      );
    }
    this.deps.artifactCache.invalidate(
      path.join(path.dirname(this.file(id, 'transcript')), 'transcript.raw.json'),
    );
    this.deps.artifactCache.invalidate(
      path.join(path.dirname(this.file(id, 'transcript')), 'diarization.json'),
    );
    this.persist(id, 'transcript', doc, this.render(id, doc));
    return {
      segments: raw.segments.length,
      named: this.deps.speakers.listForMeeting(id).filter((s) => s.displayName).length,
    };
  }
  snapshotSummary(id: string): SummaryTerms {
    const rules = this.repo
      .applicable(this.meeting(id).groupId)
      .filter((r) => r.mode === 'automatic');
    const accepted =
      this.repo.read<Document>(id, 'transcript')?.history.filter((h) => !h.undone) ?? [];
    const entries = [
      ...rules.map((r) => ({ source: r.source, replacement: r.replacement })),
      ...accepted.map((h) => ({ source: h.before, replacement: h.after })),
    ];
    const relevantText = this.text(this.file(id, 'transcript'));
    const glossary = JSON.stringify(
      entries
        .filter(
          (e) =>
            relevantText.toLowerCase().includes(e.source.toLowerCase()) ||
            relevantText.includes(e.replacement),
        )
        .slice(0, 50),
    );
    return {
      rules,
      glossary,
      transcriptRevision: hash(relevantText),
      summaryRevision: hash(this.text(this.file(id, 'summary'))),
    };
  }
  generateSummary(id: string, text: string, snapshot: SummaryTerms): string {
    if (
      hash(this.text(this.file(id, 'transcript'))) !== snapshot.transcriptRevision ||
      hash(this.text(this.file(id, 'summary'))) !== snapshot.summaryRevision
    )
      throw new Error('Meeting text changed during generation. Retry to use the latest text.');
    const doc = fresh([text]);
    this.apply(doc, findTerms(doc.units, snapshot.rules, 100_000));
    this.persist(id, 'summary', doc, doc.units[0]!);
    const transcript = this.repo.read<Document>(id, 'transcript');
    if (transcript) {
      transcript.stale = false;
      this.repo.write(id, 'transcript', transcript);
    }
    return doc.units[0]!;
  }
  saveSummary(id: string, text: string): void {
    this.recover();
    this.ensureEditable(id);
    const doc = this.document(id, 'summary');
    doc.units = [text];
    this.persist(id, 'summary', doc, text);
  }
  stale(id: string): boolean {
    return this.repo.read<Document>(id, 'transcript')?.stale ?? false;
  }
}
