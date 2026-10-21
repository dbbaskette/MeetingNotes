import { SPEAKER_AUTO_MATCH } from '../../shared/speaker-matching.js';
import type { DiarizationSegment } from './sample-extractor.js';

interface Interval { start: number; end: number; }
/** Sweep once: overlap/duplicate segments never inflate exclusive speech.
 * Count original merged turns, not fragments created by removing overlap. */
export function cleanSpeakerEvidence(segments: readonly DiarizationSegment[]): Map<string, { durationS: number; turns: number }> {
  const events = new Map<number, { speaker: string; delta: number }[]>();
  const own = new Map<string, Interval[]>();
  for (const { start, end, speaker } of segments) {
    // Bad timing can conceal overlapping voices: fail closed for the batch.
    if (!speaker || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return new Map();
    const intervals = own.get(speaker) ?? []; intervals.push({ start, end }); own.set(speaker, intervals);
    for (const [time, delta] of [[start, 1], [end, -1]] as const) {
      const list = events.get(time) ?? []; list.push({ speaker, delta }); events.set(time, list);
    }
  }
  const active = new Map<string, number>(), solo = new Map<string, Interval[]>();
  let previous: number | undefined;
  for (const time of [...events.keys()].sort((a, b) => a - b)) {
    if (previous !== undefined && time > previous && active.size === 1) {
      const speaker = active.keys().next().value!;
      const intervals = solo.get(speaker) ?? [];
      const last = intervals.at(-1);
      if (last?.end === previous) last.end = time; else intervals.push({ start: previous, end: time });
      solo.set(speaker, intervals);
    }
    for (const { speaker, delta } of events.get(time)!) {
      const count = (active.get(speaker) ?? 0) + delta;
      if (count > 0) active.set(speaker, count); else active.delete(speaker);
    }
    previous = time;
  }
  const result = new Map<string, { durationS: number; turns: number }>();
  for (const [speaker, intervals] of own) {
    const merged: Interval[] = [];
    for (const interval of intervals.sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1);
      if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
      else merged.push({ ...interval });
    }
    const clean = solo.get(speaker) ?? [];
    let index = 0, turns = 0;
    for (const turn of merged) {
      let duration = 0;
      while (index < clean.length && clean[index]!.start < turn.end) {
        const interval = clean[index++]!;
        duration += Math.max(0, Math.min(turn.end, interval.end) - Math.max(turn.start, interval.start));
      }
      if (duration >= SPEAKER_AUTO_MATCH.cleanTurnDurationS) turns++;
    }
    result.set(speaker, { turns, durationS: clean.reduce((sum, interval) => sum + interval.end - interval.start, 0) });
  }
  return result;
}
