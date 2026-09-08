import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { registerIpcHandlers, type IpcServices } from '../ipc/handlers.js';
import { buildSpeakerReviewMetadata } from '../speakers/review-metadata.js';
import type { DiarSegment, WhisperSegment } from '../lib/merge-transcript.js';
import { ArtifactCache } from './artifact-cache.js';

const TRANSCRIPT_LINES = 250_000;
const RAW_SEGMENTS = 14_400;
const DIARIZATION_SEGMENTS = 4_800;
const RUNS = 3;
const PARSE_BUDGET_MS = 50;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Measurement {
  run: number;
  mode: string;
  wallMs: number;
  eventLoopDelayMaxMs: number;
  bytesRead: number;
  jsonParseMs: number;
  parseTasks: Array<{ artifact: string; ms: number }>;
  serializedPayloadBytes: number;
}

interface RawTranscript { text: string; segments: WhisperSegment[] }
interface Diarization { segments: DiarSegment[] }
type Handler = (event: unknown, id: string) => unknown;

// Explicit opt-in: fixture generation, I/O, and timing never run in the regular suite.
describe.skipIf(process.env.MN_ARTIFACT_BENCH !== '1')('meeting artifact loading benchmark (#209)', () => {
  it('records three old-all-artifact / shell-cold / shell-warm comparisons and parse probes', async () => {
    const libraryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mn-artifact-bench-'));
    const folder = path.join(libraryRoot, 'meetings', 'four-hour-benchmark');
    const measurements: Measurement[] = [];
    let current: Measurement | undefined;
    const nativeParse = JSON.parse;
    const nativeReadFileSync = fs.readFileSync;
    try {
      await fsp.mkdir(folder, { recursive: true });
      const rawSegments = Array.from({ length: RAW_SEGMENTS }, (_, i) => ({
        start: i, end: i + 1,
        text: `Agenda item ${i}: discuss delivery risks, record the decision, and confirm the next owner.`,
      }));
      const rawText = rawSegments.map((segment) => segment.text).join(' ');
      const diarization = Array.from({ length: DIARIZATION_SEGMENTS }, (_, i) => ({
        start: i * 3, end: (i + 1) * 3, speaker: `SPEAKER_0${i % 4}`,
      }));
      // Deliberately stress-expanded markdown; segment JSON represents four hours.
      // This is not a claim that 250,000 spoken utterances fit in four hours.
      const transcript = Array.from({ length: TRANSCRIPT_LINES }, (_, i) =>
        `[SPEAKER_0${i % 4} ${Math.floor((i % RAW_SEGMENTS) / 60)}:${String(i % 60).padStart(2, '0')}] ${rawSegments[i % RAW_SEGMENTS]!.text}`,
      ).join('\n') + '\n';
      const summary = '# Four-hour planning session\n\n' + '- Decision: confirm an owner and follow up on delivery risks.\n'.repeat(32);
      const fixture = {
        'transcript.md': transcript,
        'transcript.raw.json': JSON.stringify({ benchmarkArtifact: 'raw', text: rawText, segments: rawSegments }),
        'diarization.json': JSON.stringify({ benchmarkArtifact: 'diarization', segments: diarization }),
        'summary.md': summary,
      };
      await Promise.all(Object.entries(fixture).map(([name, source]) => fsp.writeFile(path.join(folder, name), source)));
      expect(transcript.split('\n').length - 1).toBeGreaterThanOrEqual(250_000);

      const meeting = {
        id: 'benchmark', slug: 'four-hour-benchmark', title: 'Four-hour benchmark',
        startedAt: '2026-09-08T12:00:00Z', durationS: RAW_SEGMENTS,
        pipelineStage: 'done', status: 'done', errorMessage: null,
        stageStartedAt: null, skipSpeakerId: false, audioPath: '/benchmark/audio.m4a',
      };
      const links = Array.from({ length: 4 }, (_, i) => ({
        localLabel: `SPEAKER_0${i}`, rosterId: `person-${i}`, displayName: `Person ${i}`, confidence: 1,
      }));
      const makeCache = () => new ArtifactCache({
        readFile: async (filePath) => {
          const source = await fsp.readFile(filePath, 'utf8');
          if (current) current.bytesRead += Buffer.byteLength(source);
          return source;
        },
      });
      const makeHandlers = (artifactCache: ArtifactCache) => {
        const handlers = new Map<string, Handler>();
        registerIpcHandlers({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never, {
          libraryRoot, artifactCache,
          meetings: { findById: () => meeting },
          speakers: {
            listForMeeting: () => links.map(({ rosterId, ...link }) => ({ ...link, rosterSpeakerId: rosterId })),
            list: () => [],
          },
          actionItems: { listByMeeting: () => [] },
          settings: { getAll: () => ({ sttModel: 'benchmark-stt', llmModel: 'benchmark-llm' }) },
        } as unknown as IpcServices);
        return handlers;
      };
      // Reuse identical non-artifact metadata for the historical artifact path.
      // Repositories are deterministic stubs; database and Electron transport are excluded.
      const shellTemplate = await makeHandlers(makeCache()).get('meetings:get')!(null, meeting.id) as Record<string, unknown>;

      vi.spyOn(fs, 'readFileSync').mockImplementation(((filePath: fs.PathOrFileDescriptor, options: unknown) => {
        const source = nativeReadFileSync(filePath, options as never);
        if (current && typeof filePath === 'string' && path.dirname(filePath) === folder) {
          current.bytesRead += Buffer.byteLength(source);
        }
        return source;
      }) as typeof fs.readFileSync);
      vi.spyOn(JSON, 'parse').mockImplementation((source: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
        const start = performance.now();
        const result = nativeParse(source, reviver);
        const elapsed = performance.now() - start;
        // Ignore unrelated framework parsing; only tag this fixture's JSON work.
        if (current && source.startsWith('{"benchmarkArtifact":')) {
          current.parseTasks.push({ artifact: result.benchmarkArtifact, ms: elapsed });
          current.jsonParseMs += elapsed;
        }
        return result;
      });

      // Artifact sequence from pre-209 meetings:get (2d3f216), including the
      // second raw JSON read/parse for the early text preview and review building.
      const oldAllArtifacts = () => {
        const read = (name: string) => {
          const filePath = path.join(folder, name);
          return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
        };
        const diar = JSON.parse(fs.readFileSync(path.join(folder, 'diarization.json'), 'utf8')) as Diarization;
        const raw = JSON.parse(fs.readFileSync(path.join(folder, 'transcript.raw.json'), 'utf8')) as RawTranscript;
        const review = buildSpeakerReviewMetadata({ links, diarization: diar.segments, transcript: raw.segments });
        const preview = JSON.parse(read('transcript.raw.json')!) as RawTranscript;
        return {
          ...shellTemplate,
          speakers: links.map((link) => ({ ...link, ...review.get(link.localLabel) })),
          transcriptMd: read('transcript.md'), rawTranscriptText: preview.text, summaryMd: read('summary.md'),
        };
      };

      const measure = async (run: number, mode: string, load: () => unknown) => {
        const row: Measurement = {
          run, mode, wallMs: 0, eventLoopDelayMaxMs: 0, bytesRead: 0,
          jsonParseMs: 0, parseTasks: [], serializedPayloadBytes: 0,
        };
        // A 1 ms timer armed immediately before loading catches synchronous work
        // in this same turn; histogram reset can miss that first blocked turn.
        let previousTick = performance.now();
        const timer = setInterval(() => {
          const now = performance.now();
          row.eventLoopDelayMaxMs = Math.max(row.eventLoopDelayMaxMs, now - previousTick - 1);
          previousTick = now;
        }, 1);
        current = row;
        try {
          const start = performance.now();
          const payload = await load();
          row.serializedPayloadBytes = Buffer.byteLength(JSON.stringify(payload));
          row.wallMs = performance.now() - start;
          await pause(5); // Allow the delayed sample to run, excluded from wall time.
          measurements.push(row);
          return payload;
        } finally {
          current = undefined;
          clearInterval(timer);
        }
      };

      for (let run = 1; run <= RUNS; run++) {
        const cache = makeCache();
        const handlers = makeHandlers(cache);
        const old = () => measure(run, 'old-sync-all', oldAllArtifacts);
        const shells = async () => {
          const cold = await measure(run, 'shell-cold', () => handlers.get('meetings:get')!(null, meeting.id));
          const warm = await measure(run, 'shell-warm', () => handlers.get('meetings:get')!(null, meeting.id));
          expect(warm).toEqual(cold);
          expect(cold).not.toHaveProperty('transcriptMd');
          expect(cold).not.toHaveProperty('rawTranscriptText');
        };
        // Alternate comparison order to reduce a systematic ordering advantage.
        if (run % 2 === 1) { await old(); await shells(); }
        else { await shells(); await old(); }

        // Probe real optional handlers with warm source bytes: their remaining
        // main-thread JSON.parse tasks determine whether worker parsing is justified.
        await cache.readText(path.join(folder, 'transcript.md'));
        await cache.readText(path.join(folder, 'transcript.raw.json'));
        await cache.readText(path.join(folder, 'diarization.json'));
        await measure(run, 'transcript-warm-parse-probe', () => handlers.get('meetings:get-transcript')!(null, meeting.id));
        await measure(run, 'review-warm-parse-probe', () => handlers.get('meetings:get-speaker-review')!(null, meeting.id));
      }

      for (const row of measurements) {
        if (row.mode.startsWith('shell-')) {
          expect(row.bytesRead).toBe(row.mode === 'shell-cold' ? Buffer.byteLength(summary) : 0);
          expect(row.parseTasks).toEqual([]);
        }
        if (row.mode === 'old-sync-all') {
          expect(row.bytesRead).toBe(Object.values(fixture).reduce((sum, source) => sum + Buffer.byteLength(source), 0)
            + Buffer.byteLength(fixture['transcript.raw.json']));
          expect(row.parseTasks.map((task) => task.artifact)).toEqual(['diarization', 'raw', 'raw']);
        }
        if (row.mode.endsWith('parse-probe')) expect(row.bytesRead).toBe(0);
      }
      const slowParseRuns = measurements.filter((row) =>
        row.parseTasks.some((task) => task.ms > PARSE_BUDGET_MS)).map((row) => row.run);
      console.log('MN_ARTIFACT_BENCH_RESULT=' + JSON.stringify({
        environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
        fixture: {
          transcriptLines: TRANSCRIPT_LINES, rawSegments: RAW_SEGMENTS, diarizationSegments: DIARIZATION_SEGMENTS,
          durationS: RAW_SEGMENTS,
          bytes: Object.fromEntries(Object.entries(fixture).map(([name, source]) => [name, Buffer.byteLength(source)])),
        },
        measurements,
        workerDecision: {
          parseBudgetMs: PARSE_BUDGET_MS,
          repeatedSlowParseRuns: [...new Set(slowParseRuns)],
          workerRequired: new Set(slowParseRuns).size >= 2,
        },
      }, null, 2));
    } finally {
      vi.restoreAllMocks();
      await fsp.rm(libraryRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
