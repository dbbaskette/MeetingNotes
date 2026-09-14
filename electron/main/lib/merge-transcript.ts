import { VOICE_SPEAKER_LABEL } from './stem-paths.js';

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  /** When stem-aware transcription ran, each segment knows which stream it
   *  came from. Voice-stem segments bypass diarization matching because
   *  they're definitionally the local user. */
  source?: 'voice' | 'system';
}
export interface DiarSegment { start: number; end: number; speaker: string; }
export interface MergedSegment extends WhisperSegment { speaker: string; }

function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function mergeTranscriptWithDiarization(
  whisper: readonly WhisperSegment[],
  diar: readonly DiarSegment[],
): MergedSegment[] {
  if (whisper.length === 0) return [];
  // Sort once, then walk both sequences by start time so each whisper only
  // inspects overlapping diar turns. Equal overlap keeps the earlier original
  // diar index, matching the previous nested-scan tie-break.
  const sorted = diar.map((segment, index) => ({ segment, index }))
    .sort((a, b) => a.segment.start - b.segment.start || a.index - b.index);
  const order = whisper.map((_, index) => index)
    .sort((a, b) => whisper[a]!.start - whisper[b]!.start);
  const out: MergedSegment[] = new Array(whisper.length);
  let cursor = 0;
  for (const whisperIndex of order) {
    const w = whisper[whisperIndex]!;
    if (w.source === 'voice') {
      out[whisperIndex] = { ...w, speaker: VOICE_SPEAKER_LABEL };
      continue;
    }
    while (cursor < sorted.length && sorted[cursor]!.segment.end <= w.start) cursor++;
    let best: DiarSegment | null = null;
    let bestOverlap = 0;
    let bestIndex = Number.POSITIVE_INFINITY;
    for (let i = cursor; i < sorted.length && sorted[i]!.segment.start < w.end; i++) {
      const candidate = sorted[i]!;
      const o = overlap(w, candidate.segment);
      if (o > bestOverlap || (o === bestOverlap && o > 0 && candidate.index < bestIndex)) {
        bestOverlap = o;
        best = candidate.segment;
        bestIndex = candidate.index;
      }
    }
    out[whisperIndex] = { ...w, speaker: best ? best.speaker : 'UNKNOWN' };
  }
  return out;
}

export function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * `labelMap` maps local diarization labels (SPEAKER_00) to roster display
 * names ("Alice"). Unmapped labels are emitted verbatim, so first-pass
 * merges — before the user has identified anyone — keep the SPEAKER_00
 * style, and post-identify re-merges replace them with real names. An
 * unmapped speaker is not a bug; it means the voice is still anonymous.
 */
export function mergedToMarkdown(
  merged: readonly MergedSegment[],
  labelMap: Readonly<Record<string, string>> = {},
): string {
  return merged
    .map((s) => {
      const name = labelMap[s.speaker] ?? s.speaker;
      return `[${name} ${formatTimestamp(s.start)}] ${s.text}`;
    })
    .join('\n');
}
