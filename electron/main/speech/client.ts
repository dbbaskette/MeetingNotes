import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const Envelope = z.object({ version: z.literal(1), id: z.string(), kind: z.enum(['progress', 'result', 'error']),
  fraction: z.number().min(0).max(1).optional(), result: z.unknown().optional(),
  message: z.string().optional(), elapsedMs: z.number().nonnegative().optional() });
const Time = z.number().finite().nonnegative();
export const Transcript = z.object({ text: z.string(), segments: z.array(z.object({ start: Time, end: Time, text: z.string() })),
  provider: z.literal('apple'), locale: z.string(), osVersion: z.string(), durationS: Time });
export const Diarization = z.object({ segments: z.array(z.object({ start: Time, end: Time, speaker: z.string().regex(/^SPEAKER_\d+$/) })),
  num_speakers: z.number().int().nonnegative().max(1000), centroids: z.record(z.array(z.number().finite()).max(4096)),
  embeddingSpace: z.string().min(1), provider: z.literal('speakerkit'), modelRevision: z.string() });
export const SPEAKER_REVISION = '556fc52a13327837688f02289457cded017802e9';
export type NativeDiarization = z.infer<typeof Diarization>;

/** One process per operation: only app-owned children, no ports or server adoption. */
export class SpeechClient {
  private children = new Set<ChildProcess>();
  constructor(private readonly executable: string, private readonly timeoutMs = 30 * 60_000) {}
  cancel(): void { for (const child of this.children) child.kill('SIGTERM'); }
  async request(operation: string, args: { audioPath?: string; locale?: string; modelFolder?: string; modelRevision?: string } = {},
    options: { signal?: AbortSignal; progress?: (fraction: number) => void } = {}): Promise<{ result: unknown; elapsedMs: number }> {
    if (options.signal?.aborted) throw new Error('Speech operation cancelled.');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      // No inherited HF credentials, Python environment, or user-configured executable.
      const child = spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {
        PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      } });
      this.children.add(child);
      let buffer = '', bytes = 0, result: { result: unknown; elapsedMs: number } | undefined, failure: Error | undefined;
      let killer: ReturnType<typeof setTimeout> | undefined;
      const stop = (message: string): void => {
        failure ??= new Error(message);
        child.kill('SIGTERM');
        killer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
      };
      const abort = (): void => stop('Speech operation cancelled. Previous results were retained.');
      const timer = setTimeout(() => stop('Speech operation timed out. Previous results were retained.'), this.timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 64 * 1024 * 1024) { stop('Speech result exceeded the safe size limit.'); return; }
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const value = Envelope.parse(JSON.parse(line));
            if (value.id !== id) throw new Error('Unexpected speech request ID.');
            if (value.kind === 'progress' && value.fraction !== undefined) options.progress?.(value.fraction);
            if (value.kind === 'error') failure = new Error(value.message ?? 'Native speech failed.');
            if (value.kind === 'result') {
              if (result) throw new Error('Duplicate speech result.');
              result = { result: value.result, elapsedMs: value.elapsedMs ?? 0 };
            }
          } catch { stop('Invalid native speech response. Previous results were retained.'); }
        }
      });
      // Drain diagnostics without recording user audio paths/transcripts in shared logs.
      child.stderr.resume();
      child.on('error', error => { failure = new Error(`Speech helper could not start: ${error.message}`); });
      child.stdin.on('error', () => { /* close/error owns completion */ });
      child.on('close', code => {
        clearTimeout(timer); if (killer) clearTimeout(killer);
        options.signal?.removeEventListener('abort', abort); this.children.delete(child);
        if (failure) reject(failure);
        else if (code !== 0 || !result || buffer.trim()) reject(new Error('Speech helper stopped without a complete result. Previous results were retained.'));
        else resolve(result);
      });
      child.stdin.end(JSON.stringify({ version: 1, id, operation, ...args }) + '\n');
    });
  }
}
