import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { BetaComparison, BetaMeeting, BetaRoster, BetaStatus } from '../../shared/speech-beta.js';
import { BetaLibraryImport, ownedPath, within } from './library.js';
import { VoiceProfiles, atomicJson, normalized } from './voice-profiles.js';
import { Transcript, Diarization, SPEAKER_REVISION, type NativeDiarization, type SpeechClient } from '../speech/client.js';
import { installSpeakerModels, modelsReady } from '../speech/models.js';
import { mergeTranscriptWithDiarization, mergedToMarkdown, type MergedSegment } from '../lib/merge-transcript.js';

export function readableTurns(segments: MergedSegment[]): MergedSegment[] {
  const out: MergedSegment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === segment.speaker && segment.start - last.end <= 0.75 && segment.end - last.start <= 12) {
      const separator = /^[,.;:!?]/.test(segment.text.trimStart()) ? '' : ' ';
      last.text = last.text.trimEnd() + separator + segment.text.trimStart(); last.end = segment.end;
    } else out.push({ ...segment });
  }
  return out;
}

const Saved = z.object({ version: z.literal(1), meetingId: z.string(), generatedAt: z.string(),
  mode: z.enum(['transcript', 'full']), elapsedMs: z.number().nonnegative(), transcript: Transcript,
  diarization: Diarization.nullable(), names: z.record(z.string()), markdown: z.string() });
type SavedRun = z.infer<typeof Saved>;
interface Meeting extends BetaMeeting { slug: string; audioPath: string; }

export class BetaService {
  readonly importer: BetaLibraryImport;
  private readonly profiles: VoiceProfiles;
  private controller: AbortController | null = null;
  private busy: string | null = null;
  private progress: number | null = null;
  private error: string | null = null;
  private appleReady = false;
  private speakersReady: boolean;
  readonly modelFolder: string;
  constructor(readonly root: string, private readonly speech: SpeechClient) {
    this.importer = new BetaLibraryImport(root); this.profiles = new VoiceProfiles(root);
    this.modelFolder = ownedPath(root, 'models', SPEAKER_REVISION); this.speakersReady = modelsReady(this.modelFolder);
  }
  private async job(label: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.controller) throw new Error('A beta operation is already running. Wait or cancel it first.');
    const controller = new AbortController(); this.controller = controller;
    this.busy = label; this.progress = null; this.error = null;
    try { await work(controller.signal); }
    catch (error) { this.error = controller.signal.aborted ? 'Cancelled. Previous results were retained.' : (error as Error).message; throw new Error(this.error); }
    finally { this.controller = null; this.busy = null; this.progress = null; }
  }
  cancel(): void { this.controller?.abort(); }
  shutdown(): void { this.cancel(); this.speech.cancel(); }
  async checkApple(): Promise<void> {
    try { const { result } = await this.speech.request('health', {}, { signal: AbortSignal.timeout(10_000) }); this.appleReady = z.object({ installed: z.boolean() }).parse(result).installed; }
    catch { this.appleReady = false; }
  }
  private database(): Database.Database {
    return new Database(ownedPath(this.importer.destination, 'db.sqlite'), { readonly: true, fileMustExist: true });
  }
  private meeting(id: string): Meeting {
    const db = this.database();
    try {
      const row = db.prepare(`SELECT m.id,m.title,m.slug,m.audio_path AS audioPath,m.duration_s AS durationS,g.name AS groupName
        FROM meetings m LEFT JOIN groups g ON m.group_id=g.id WHERE m.id=? AND m.deleted_at IS NULL`).get(id) as Meeting | undefined;
      if (!row) throw new Error('This meeting is not in the beta library.');
      ownedPath(this.importer.destination, 'meetings', row.slug);
      if (!within(this.importer.destination, path.resolve(row.audioPath))) throw new Error('This meeting references audio outside the beta copy. Import it again safely.');
      return row;
    } finally { db.close(); }
  }
  private roster(): BetaRoster[] {
    if (!fs.existsSync(this.importer.destination)) return [];
    const db = this.database();
    try { return db.prepare('SELECT id,display_name AS displayName FROM speakers ORDER BY display_name').all() as BetaRoster[]; }
    finally { db.close(); }
  }
  status(): BetaStatus {
    const imported = fs.existsSync(path.join(this.importer.destination, 'beta-snapshot.json'));
    let meetings: BetaMeeting[] = [];
    if (imported) {
      const db = this.database();
      try { meetings = db.prepare(`SELECT m.id,m.title,m.duration_s AS durationS,g.name AS groupName FROM meetings m
        LEFT JOIN groups g ON m.group_id=g.id WHERE m.deleted_at IS NULL ORDER BY m.started_at DESC,m.id`).all() as BetaMeeting[]; }
      finally { db.close(); }
    }
    return { library: this.importer.destination, imported, busy: this.busy, progress: this.progress, error: this.error,
      appleReady: this.appleReady, speakersReady: this.speakersReady, meetings, roster: this.roster() };
  }
  async importLibrary(): Promise<void> {
    await this.job('Copying library', signal => this.importer.run(signal, fraction => { this.progress = fraction; }));
  }
  async prepare(provider: 'apple' | 'speakers'): Promise<void> {
    await this.job(provider === 'apple' ? 'Preparing Apple transcription' : 'Downloading speaker models', async signal => {
      if (provider === 'apple') {
        await this.speech.request('provision-apple', {}, { signal, progress: fraction => { this.progress = fraction; } });
        await this.checkApple(); if (!this.appleReady) throw new Error('Apple transcription assets are not ready yet.');
      } else {
        await installSpeakerModels(this.modelFolder, signal, fraction => { this.progress = fraction; });
        this.speakersReady = modelsReady(this.modelFolder);
      }
    });
  }
  private resultFile(id: string): string {
    return ownedPath(this.root, 'results', `${createHash('sha256').update(id).digest('hex')}.json`);
  }
  private saved(id: string): SavedRun | null {
    try { return Saved.parse(JSON.parse(fs.readFileSync(this.resultFile(id), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Saved beta result is unreadable. It was retained for recovery.'); }
  }
  private text(meeting: Meeting, name: string): string {
    const file = ownedPath(this.importer.destination, 'meetings', meeting.slug, name);
    if (!fs.existsSync(file)) return '';
    if (fs.statSync(file).size > 20_000_000) throw new Error('This artifact exceeds the comparison size limit.');
    return fs.readFileSync(file, 'utf8');
  }
  compare(id: string): BetaComparison {
    const meeting = this.meeting(id), run = this.saved(id), roster = this.roster();
    const diar = run?.diarization;
    const labels = [...new Set(diar?.segments.map(s => s.speaker) ?? [])];
    return { meetingId: id, title: meeting.title, original: this.text(meeting, 'transcript.md'), notes: this.text(meeting, 'summary.md'),
      result: run?.markdown ?? null, elapsedMs: run?.elapsedMs ?? null, mode: run?.mode ?? null,
      audioUrl: fs.existsSync(meeting.audioPath) ? `beta-audio://meeting/${encodeURIComponent(id)}` : null,
      generatedAt: run?.generatedAt ?? null,
      voices: labels.map(label => ({ label, name: roster.find(p => p.id === run?.names[label])?.displayName ?? null,
        canEnroll: !!normalized(diar?.centroids[label] ?? []),
        candidates: this.profiles.suggestions(diar!.embeddingSpace, diar!.centroids[label] ?? [], roster) })) };
  }
  audioPath(id: string): string {
    const meeting = this.meeting(id);
    const file = ownedPath(this.importer.destination, path.relative(this.importer.destination, meeting.audioPath));
    if (!fs.existsSync(file)) throw new Error('Audio was missing from the original library copy.');
    return file;
  }
  async run(id: string, mode: 'transcript' | 'full'): Promise<void> {
    await this.job(mode === 'full' ? 'Transcribing and identifying voices' : 'Transcribing with Apple', async signal => {
      if (!this.appleReady) throw new Error('Prepare Apple transcription first.');
      if (mode === 'full' && !this.speakersReady) throw new Error('Download the speaker models first.');
      const meeting = this.meeting(id), audioPath = this.audioPath(id);
      const begin = performance.now();
      const raw = await this.speech.request('transcribe', { audioPath }, { signal });
      const transcript = Transcript.parse(raw.result);
      let previous = -1;
      for (const s of transcript.segments) {
        if (s.start < previous || s.end < s.start || s.end > transcript.durationS + 0.5) throw new Error('Invalid transcript timestamps; previous results retained.');
        previous = s.start;
      }
      let diarization: NativeDiarization | null = null;
      let turns: { start: number; end: number; speaker: string }[] = [];
      const names: Record<string, string> = {};
      const labelNames: Record<string, string> = {};
      if (mode === 'full') {
        const response = await this.speech.request('diarize', { audioPath, modelFolder: this.modelFolder, modelRevision: SPEAKER_REVISION }, { signal });
        diarization = Diarization.parse(response.result);
        if (diarization.modelRevision !== SPEAKER_REVISION) throw new Error('Unexpected speaker model revision.');
        for (const turn of diarization.segments) if (turn.end < turn.start || turn.end > transcript.durationS + 0.5) throw new Error('Invalid speaker timestamps.');
        turns = diarization.segments;
        // Calibration is not complete: show guesses, never auto-enroll or auto-link.
      } else {
        const baseline = this.text(meeting, 'diarization.json');
        if (baseline) turns = z.object({ segments: z.array(z.object({ start: z.number().finite(), end: z.number().finite(), speaker: z.string() })) }).parse(JSON.parse(baseline)).segments;
        const db = this.database();
        try {
          const rows = db.prepare(`SELECT ms.local_label AS label,s.display_name AS name FROM meeting_speakers ms
            JOIN speakers s ON s.id=ms.roster_speaker_id WHERE ms.meeting_id=?`).all(id) as { label: string; name: string }[];
          for (const row of rows) labelNames[row.label] = row.name;
        } finally { db.close(); }
      }
      signal.throwIfAborted();
      const markdown = mergedToMarkdown(readableTurns(mergeTranscriptWithDiarization(transcript.segments, turns)), labelNames);
      atomicJson(this.resultFile(id), { version: 1, meetingId: id, generatedAt: new Date().toISOString(), mode,
        elapsedMs: performance.now() - begin, transcript, diarization, names, markdown });
    });
  }
  confirm(id: string, label: string, rosterId: string): void {
    if (this.busy) throw new Error('Wait for processing to finish before naming a voice.');
    const run = this.saved(id), person = this.roster().find(p => p.id === rosterId);
    if (!run?.diarization || !person || !run.diarization.segments.some(s => s.speaker === label)) throw new Error('Choose a detected voice and an existing saved person.');
    const vector = run.diarization.centroids[label];
    // Naming still succeeds without a usable embedding. Profile updates require explicit confirmation.
    if (normalized(vector ?? [])) this.profiles.confirm(run.diarization.embeddingSpace, rosterId, vector!);
    run.names[label] = rosterId;
    const roster = this.roster(), labelNames: Record<string, string> = {};
    for (const [key, value] of Object.entries(run.names)) labelNames[key] = roster.find(p => p.id === value)?.displayName ?? key;
    run.markdown = mergedToMarkdown(readableTurns(mergeTranscriptWithDiarization(run.transcript.segments, run.diarization.segments)), labelNames);
    atomicJson(this.resultFile(id), run);
  }
}
