// electron/main/pipeline/stages/transcribing.ts
import path from 'node:path';
import type { StageHandler } from '../context.js';
import { meetingFolderPath } from '../../storage/meeting-folder.js';
import { atomicJson } from '../../speakers/voice-profiles.js';
import { speechVocabulary } from '../../speech/vocabulary.js';

export const runTranscribing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  ctx.logger.info('transcribe:start', { meetingId });
  if (!ctx.nativeSpeech) throw new Error('Native speech helper is not configured.');
  const engine = ctx.speechSelection?.engine ?? 'apple';
  // Names and dictionary spellings are offered to the engine as vocabulary.
  // A failure to read them must not stop transcription.
  let vocabulary: string[] = [];
  try {
    vocabulary = speechVocabulary({
      terms: ctx.terminology?.repo.applicable(meeting.groupId ?? null).map(rule => rule.replacement),
      userName: ctx.settings.get('userName'),
      speakers: ctx.speakers.list().map(speaker => speaker.displayName),
    });
  } catch (error) { ctx.logger.warn('transcribe:vocabulary-unavailable', { meetingId, error: String(error) }); }
  const result = await ctx.nativeSpeech.transcribe(meeting.audioPath, ctx.speechSelection?.language ?? ctx.settings.get('sttLanguage'),
    { signal: ctx.signal, progress: ctx.onTranscriptionProgress, engine, vocabulary });
  ctx.signal?.throwIfAborted();
  atomicJson(path.join(folder, 'transcript.raw.json'), { ...result, segments: result.segments.map(s => ({ ...s, wordTiming: true })) });
  ctx.artifactCache.invalidate(path.join(folder, 'transcript.raw.json'));
  ctx.logger.info('transcribe:done', { meetingId, provider: result.provider, vocabulary: vocabulary.length, segments: result.segments.length });
};
