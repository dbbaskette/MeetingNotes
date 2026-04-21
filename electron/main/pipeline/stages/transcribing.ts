// electron/main/pipeline/stages/transcribing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler, PipelineContext } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { ensureWav } from '../../lib/ensure-wav.js';
import { deriveStemPaths, hasStems } from '../../lib/stem-paths.js';
import type { TranscribeResult } from '../../lm-studio/client.js';

export const runTranscribing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  ctx.logger.info('transcribe:start', { meetingId });

  // Stem-aware path: when the dual-stem capture wrote voice/system sidecars
  // (issue #13), transcribe each stream independently. This produces cleaner
  // transcripts because Whisper isn't fighting overlapping voices, and gives
  // us a deterministic "You" label at merge time without any embedding
  // matching. We still write a single combined transcript.raw.json so
  // downstream stages see one unified shape.
  if (hasStems(meeting.audioPath)) {
    const { voice, system } = deriveStemPaths(meeting.audioPath);
    // Sequential rather than parallel: whisper-server is single-threaded and
    // parallel transcripts just queue behind each other on the server side,
    // making logs noisier and giving no real throughput.
    const voiceRaw = await transcribeFile(ctx, voice);
    const systemRaw = await transcribeFile(ctx, system);

    const dropBeyondEoa = (segs: TranscribeResult['segments']): TranscribeResult['segments'] =>
      meeting.durationS != null
        ? segs.filter((s) => s.start < (meeting.durationS as number) + 0.5)
        : segs;
    const vSegs = dropBeyondEoa(voiceRaw.segments);
    const sSegs = dropBeyondEoa(systemRaw.segments);

    fs.writeFileSync(
      path.join(folder, 'transcript.voice.raw.json'),
      JSON.stringify({ ...voiceRaw, segments: vSegs }, null, 2),
    );
    fs.writeFileSync(
      path.join(folder, 'transcript.system.raw.json'),
      JSON.stringify({ ...systemRaw, segments: sSegs }, null, 2),
    );

    // Combined view, with source markers so merge-transcript can label
    // voice segments as "You" without consulting diarization. Sorted by
    // start time so the final transcript reads chronologically.
    const sourced = [
      ...vSegs.map((s) => ({ ...s, source: 'voice' as const })),
      ...sSegs.map((s) => ({ ...s, source: 'system' as const })),
    ].sort((a, b) => a.start - b.start);
    const combinedText = sourced.map((s) => s.text).join('\n');
    fs.writeFileSync(
      path.join(folder, 'transcript.raw.json'),
      JSON.stringify({ text: combinedText, segments: sourced }, null, 2),
    );
    ctx.logger.info('transcribe:done', {
      meetingId,
      segments: sourced.length,
      voiceSegments: vSegs.length,
      systemSegments: sSegs.length,
      stemAware: true,
    });
    return;
  }

  // Backward-compat single-file path — meetings recorded before #13 Phase 1
  // landed, or sources that didn't produce stems (legacy Audio Hijack MP3s).
  const wav = await ensureWav(meeting.audioPath);
  try {
    const result = await ctx.stt.transcribe({
      audioPath: wav.path,
      model: ctx.settings.get('sttModel'),
      language: ctx.settings.get('sttLanguage'),
    });
    const kept = meeting.durationS != null
      ? result.segments.filter((s) => s.start < (meeting.durationS as number) + 0.5)
      : result.segments;
    const dropped = result.segments.length - kept.length;
    fs.writeFileSync(
      path.join(folder, 'transcript.raw.json'),
      JSON.stringify({ ...result, segments: kept }, null, 2),
    );
    ctx.logger.info('transcribe:done', { meetingId, segments: kept.length, dropped });
  } finally {
    wav.cleanup();
  }
};

async function transcribeFile(ctx: PipelineContext, audioPath: string): Promise<TranscribeResult> {
  const wav = await ensureWav(audioPath);
  try {
    return await ctx.stt.transcribe({
      audioPath: wav.path,
      model: ctx.settings.get('sttModel'),
      language: ctx.settings.get('sttLanguage'),
    });
  } finally {
    wav.cleanup();
  }
}
