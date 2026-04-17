export interface WhisperSegment { start: number; end: number; text: string; }
export interface DiarSegment { start: number; end: number; speaker: string; }
export interface MergedSegment extends WhisperSegment { speaker: string; }

function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function mergeTranscriptWithDiarization(
  whisper: readonly WhisperSegment[],
  diar: readonly DiarSegment[],
): MergedSegment[] {
  return whisper.map((w) => {
    let best: DiarSegment | null = null;
    let bestOverlap = 0;
    for (const d of diar) {
      const o = overlap(w, d);
      if (o > bestOverlap) { bestOverlap = o; best = d; }
    }
    return { ...w, speaker: best ? best.speaker : 'UNKNOWN' };
  });
}

export function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function mergedToMarkdown(merged: readonly MergedSegment[]): string {
  return merged.map((s) => `[${s.speaker} ${formatTimestamp(s.start)}] ${s.text}`).join('\n');
}
