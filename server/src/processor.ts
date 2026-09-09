import { spawn } from 'node:child_process';
import { openAsBlob } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Config } from './config.js';
import type { JobRow } from './db.js';
import { ServiceError } from './util.js';
import {
  RemoteTextInputSchema,
  RemoteTranscriptionSchema,
  RemoteDiarizationSchema,
  RemoteTextResultSchema,
  RemoteActionItemsSchema,
  type RemoteDiarization,
} from '../../shared/remote-contracts.js';
import {
  buildSummaryPrompt,
  ACTION_ITEM_SYSTEM_PROMPT,
} from '../../electron/main/pipeline/prompts.js';
export type Stage = <T>(
  name: 'transcription' | 'diarization' | 'text',
  schema: z.ZodType<T>,
  compute: () => Promise<T>,
) => Promise<T>;
export async function runCommand(
  command: string,
  args: string[],
  signal: AbortSignal,
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      signal,
      timeout,
      killSignal: 'SIGKILL',
      env: { ...process.env, OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 65536) child.kill('SIGKILL');
    });
    child.once('error', () =>
      reject(new ServiceError(signal.aborted ? 'CANCELLED' : 'PROCESS_FAILED', 422)),
    );
    child.once('close', (code) =>
      code === 0 ? resolve(output) : reject(new ServiceError('MEDIA_OR_MODEL_FAILED', 422)),
    );
  });
}
export async function boundedJson(response: Response, maxBytes = 20_000_000): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ServiceError(
      response.status === 429 || response.status >= 500
        ? 'PROVIDER_UNAVAILABLE'
        : 'PROVIDER_REJECTED',
      response.status === 429 || response.status >= 500 ? 503 : 422,
      response.status === 429 || response.status >= 500,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceError('EMPTY_PROVIDER_RESULT');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new ServiceError('PROVIDER_RESULT_TOO_LARGE');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
  }
}
export function sanitizeDiarization(raw: unknown, c: Config): RemoteDiarization {
  const input = z
    .object({
      segments: z
        .array(
          z.object({
            start: z.number().finite().nonnegative(),
            end: z.number().finite().nonnegative(),
            speaker: z.string().max(100),
            embedding: z.array(z.unknown()).max(4096),
          }),
        )
        .max(100_000),
    })
    .parse(raw);
  const warnings: string[] = [];
  const segments = input.segments.map((s) => {
    const vector = s.embedding;
    let norm = 0;
    const valid =
      vector.length === c.profile.embeddingIdentity.dimension &&
      vector.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (valid) norm = Math.hypot(...(vector as number[]));
    if (!valid || !Number.isFinite(norm) || norm === 0) {
      if (warnings.length < 1000) warnings.push('INVALID_EMBEDDING_UNKNOWN_SPEAKER');
      return { ...s, speaker: 'unknown', embedding: [] };
    }
    return { ...s, embedding: (vector as number[]).map((x) => x / norm) };
  });
  return RemoteDiarizationSchema.parse({
    segments,
    num_speakers: new Set(segments.map((s) => s.speaker)).size,
    embeddingIdentity: c.profile.embeddingIdentity,
    warnings,
  });
}
export async function validateText(pathname: string, c: Config) {
  const input = RemoteTextInputSchema.parse(JSON.parse(await readFile(pathname, 'utf8')));
  if (input.transcript.length > c.MAX_TEXT_CHARACTERS) throw new ServiceError('CONTEXT_LIMIT');
  return input;
}
export class Processor {
  constructor(readonly c: Config) {}
  async process(job: JobRow, source: string, scratch: string, signal: AbortSignal, stage: Stage) {
    const c = this.c;
    if (c.PROCESSOR === 'synthetic') {
      if (job.kind === 'audio_analysis')
        return {
          transcription: await stage('transcription', RemoteTranscriptionSchema, async () => ({
            segments: [
              {
                start: 0,
                end: 5,
                text: 'Synthetic meeting. Speaker will verify the remote result.',
              },
            ],
          })),
          diarization: await stage('diarization', RemoteDiarizationSchema, async () => ({
            segments: [{ start: 0, end: 5, speaker: 'SPEAKER_00', embedding: [1, 0, 0] }],
            num_speakers: 1,
            embeddingIdentity: c.profile.embeddingIdentity,
            warnings: [],
          })),
        };
      await validateText(source, c);
      return {
        text: await stage('text', RemoteTextResultSchema, async () => ({
          summary:
            '## Overview\nSynthetic remote processing completed.\n\n## Action Items\n- Verify the remote result (owner TBD) (no date).',
          actionItems: [{ text: 'Verify the remote result', owner: null, due_date: null }],
        })),
      };
    }
    if (job.kind === 'text_generation') {
      const input = await validateText(source, c);
      return {
        text: await stage('text', RemoteTextResultSchema, async () => {
          const chat = async (system: string, user: string, maxTokens: number) => {
            // UTF-8 byte count is a conservative tokenizer-independent upper bound
            // for the supported byte-level BPE provider profile, including output reserve.
            if (Buffer.byteLength(system + user, 'utf8') + maxTokens + 128 > c.LLM_CONTEXT_TOKENS)
              throw new ServiceError('CONTEXT_LIMIT');
            const response = await fetch(c.LLM_URL!, {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.any([signal, AbortSignal.timeout(c.INFERENCE_TIMEOUT_MS)]),
              headers: {
                'content-type': 'application/json',
                ...(c.LLM_KEY ? { authorization: `Bearer ${c.LLM_KEY}` } : {}),
              },
              body: JSON.stringify({
                model: c.LLM_MODEL,
                messages: [
                  { role: 'system', content: system },
                  { role: 'user', content: user },
                ],
                temperature: 0.2,
                max_tokens: maxTokens,
                stream: false,
                ...(input.disableThinking
                  ? { chat_template_kwargs: { enable_thinking: false } }
                  : {}),
              }),
            });
            const result = z
              .object({
                choices: z
                  .array(z.object({ message: z.object({ content: z.string().max(1_000_000) }) }))
                  .min(1),
              })
              .parse(await boundedJson(response, 2_000_000));
            return result.choices[0].message.content
              .replace(/<think>[\s\S]*?<\/think>/gi, '')
              .trim();
          };
          let summary = await chat(
            buildSummaryPrompt(input.summaryDetail, input.title),
            input.transcript,
            8192,
          );
          const overview = summary.search(/^#{1,2} Overview/m);
          if (overview < 0) throw new ServiceError('INVALID_SUMMARY');
          summary = summary.slice(overview).replace(/^# Overview/m, '## Overview');
          const extracted = await chat(ACTION_ITEM_SYSTEM_PROMPT, summary, 4096);
          return RemoteTextResultSchema.parse({
            summary,
            actionItems: RemoteActionItemsSchema.parse(JSON.parse(extracted)),
          });
        }),
      };
    }
    const decoded = path.join(scratch, 'decoded.wav');
    // Bound decode output even if the container reports a false duration. Never decode from URLs.
    await runCommand(
      'ffmpeg',
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        'wav,mp3,mov,aac,flac,ogg',
        '-i',
        source,
        '-t',
        String(c.MAX_DURATION_SECONDS + 1),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        decoded,
      ],
      signal,
      c.INFERENCE_TIMEOUT_MS,
    );
    const decodedBytes = (await stat(decoded)).size;
    if (decodedBytes <= 44 || decodedBytes > c.MAX_DURATION_SECONDS * 32000 + 1024)
      throw new ServiceError('DURATION_LIMIT');
    const duration = Number(
      await runCommand(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          decoded,
        ],
        signal,
        30000,
      ),
    );
    if (!Number.isFinite(duration) || duration <= 0 || duration > c.MAX_DURATION_SECONDS)
      throw new ServiceError('DURATION_LIMIT');
    const transcription = await stage('transcription', RemoteTranscriptionSchema, async () => {
      const segments: { start: number; end: number; text: string }[] = [];
      // 5-minute PCM chunks keep each provider upload below common 25 MiB limits.
      for (let offset = 0; offset < duration; offset += 300) {
        const chunk = path.join(scratch, `stt-${offset}.wav`);
        await runCommand(
          'ffmpeg',
          [
            '-nostdin',
            '-loglevel',
            'error',
            '-ss',
            String(offset),
            '-i',
            decoded,
            '-t',
            '300',
            '-c:a',
            'copy',
            chunk,
          ],
          signal,
          30000,
        );
        const form = new FormData();
        form.append('file', await openAsBlob(chunk, { type: 'audio/wav' }), 'audio.wav');
        form.append('model', c.TRANSCRIPTION_MODEL);
        form.append('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'segment');
        const response = await fetch(c.TRANSCRIPTION_URL!, {
          method: 'POST',
          body: form,
          redirect: 'error',
          headers: c.TRANSCRIPTION_KEY ? { authorization: `Bearer ${c.TRANSCRIPTION_KEY}` } : {},
          signal: AbortSignal.any([signal, AbortSignal.timeout(c.INFERENCE_TIMEOUT_MS)]),
        });
        const value = z
          .object({
            segments: z
              .array(
                z.object({
                  start: z.number().finite().nonnegative(),
                  end: z.number().finite().nonnegative(),
                  text: z.string().max(100000),
                }),
              )
              .max(100000),
          })
          .parse(await boundedJson(response));
        for (const s of value.segments) {
          if (s.end < s.start || s.end > Math.min(300, duration - offset) + 1)
            throw new ServiceError('INVALID_TRANSCRIPTION');
          segments.push({ ...s, start: s.start + offset, end: Math.min(duration, s.end + offset) });
        }
      }
      return RemoteTranscriptionSchema.parse({ segments });
    });
    const diarization = await stage('diarization', RemoteDiarizationSchema, async () => {
      const output = path.join(scratch, 'diarization-output.json');
      await runCommand(
        c.PYTHON,
        [
          fileURLToPath(new URL('../python/diarize.py', import.meta.url)),
          decoded,
          output,
          c.DIARIZATION_MODEL_PATH!,
          c.EMBEDDING_MODEL_PATH!,
        ],
        signal,
        c.INFERENCE_TIMEOUT_MS,
      );
      if ((await stat(output)).size > 20_000_000) throw new ServiceError('RESULT_TOO_LARGE');
      const value = sanitizeDiarization(JSON.parse(await readFile(output, 'utf8')), c);
      if (value.segments.some((s) => s.end > duration + 1))
        throw new ServiceError('INVALID_DIARIZATION');
      return value;
    });
    return { transcription, diarization };
  }
}
