import fs from 'node:fs/promises';
import path from 'node:path';
import { Agent } from 'undici';

// Local LLM calls (chat completions, audio transcription) routinely hold
// a response open for 5–10+ minutes on large inputs while the model
// generates. undici's default `headersTimeout` is 5 minutes, which fires
// BEFORE our AbortSignal.timeout(10min) and surfaces as
// "fetch failed: Headers Timeout Error" — looking like a network failure
// when the model is actually still working. We bump both header and body
// timeouts well past the AbortSignal ceiling so the abort signal is the
// thing that wins, not undici's defaults.
//
// Lazily constructed so test environments can run without instantiating
// a real Agent (vitest's happy-dom otherwise objects).
let slowLLMAgent: Agent | undefined;
function getSlowLLMAgent(): Agent {
  if (!slowLLMAgent) {
    slowLLMAgent = new Agent({
      headersTimeout: 15 * 60 * 1000,
      bodyTimeout: 15 * 60 * 1000,
      connectTimeout: 30 * 1000,
    });
  }
  return slowLLMAgent;
}

// `fetch`'s global TS signature doesn't expose undici's `dispatcher` option,
// even though Node's runtime fetch accepts it. Cast through this helper so
// the cast lives in one place and the call sites stay clean.
type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: Agent };
function fetchWithDispatcher(url: string, init: FetchInit): Promise<Response> {
  return fetch(url, init as Parameters<typeof fetch>[1]);
}

function mimeFromExt(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop();
  switch (ext) {
    case 'wav': return 'audio/wav';
    case 'mp3': return 'audio/mpeg';
    case 'm4a': case 'mp4': return 'audio/mp4';
    case 'flac': return 'audio/flac';
    case 'ogg': return 'audio/ogg';
    default: return 'application/octet-stream';
  }
}

export class LMStudioError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
  }
}

function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  // undici/fetch nests the real reason in .cause (e.g. ECONNRESET, ECONNREFUSED).
  // Pull it out so the surfaced message is specific instead of the generic
  // "fetch failed" that Node emits at the outer level.
  const cause = (e as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return `${e.message}: ${cause.message}`;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    return `${e.message}: ${String((cause as { code: unknown }).code)}`;
  }
  return e.message || 'unknown error';
}

export interface TranscribeInput {
  audioPath: string;
  model: string;
  language?: string;
  readFile?: (p: string) => Promise<Uint8Array>;
}

export interface TranscribeResult {
  text: string;
  segments: { start: number; end: number; text: string }[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatInput {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export class LMStudioClient {
  /** Either a fixed URL string or a resolver function (for the
   *  Phase 3 managed-LLM-provider path, where the URL switches
   *  between LM Studio's :1234 and Ollama's :11434 based on the
   *  user's summaryProvider setting). */
  constructor(private readonly urlOrResolver: string | (() => string)) {}

  /** Live-resolved base URL. Existing code reads `this.baseUrl` so
   *  this getter keeps the call sites unchanged. */
  get baseUrl(): string {
    return typeof this.urlOrResolver === 'string'
      ? this.urlOrResolver
      : this.urlOrResolver();
  }

  async listModels(): Promise<string[]> {
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      throw new LMStudioError(`LM Studio unreachable at ${this.baseUrl}`, e);
    }
    if (!resp.ok) throw new LMStudioError(`LM Studio ${resp.status} on /v1/models`);
    const body = (await resp.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const read = input.readFile ?? ((p: string) => fs.readFile(p));
    const bytes = await read(input.audioPath);

    // whisper.cpp's whisper-server exposes BOTH /inference (native, always
    // available) and /v1/audio/transcriptions (OpenAI-compat, newer builds).
    // Try OpenAI first for consistency with other STT servers, fall back to
    // /inference on 404 so older whisper-cpp builds still work.
    const buildForm = (modelField: boolean): FormData => {
      const f = new FormData();
      if (modelField) f.append('model', input.model);
      f.append('response_format', 'verbose_json');
      if (input.language) f.append('language', input.language);
      // Anti-hallucination settings for whisper.cpp. Meeting audio with long
      // pauses or side chatter is prone to "stuck in a loop" output like
      // "Do I have to create a new one?" repeated 50x. These params break the
      // loop: no_context stops conditioning each chunk on the previous chunk's
      // (possibly bad) output, and the temperature fallback lets the decoder
      // re-sample when the greedy path looks degenerate.
      f.append('temperature', '0.0');
      f.append('temperature_inc', '0.2');
      f.append('no_context', 'true');
      // entropy_thold / logprob_thold trigger the temperature fallback when
      // the decoder's confidence tanks (signature of a loop).
      f.append('entropy_thold', '2.4');
      f.append('logprob_thold', '-1.0');
      f.append(
        'file',
        new Blob([bytes as BlobPart], { type: mimeFromExt(input.audioPath) }),
        path.basename(input.audioPath),
      );
      return f;
    };

    const post = async (path: string, modelField: boolean): Promise<Response> => {
      try {
        return await fetchWithDispatcher(`${this.baseUrl}${path}`, {
          method: 'POST',
          body: buildForm(modelField),
          signal: AbortSignal.timeout(10 * 60 * 1000),
          dispatcher: getSlowLLMAgent(),
        });
      } catch (e) {
        throw new LMStudioError(`STT POST ${this.baseUrl}${path} failed: network`, e);
      }
    };

    let resp = await post('/v1/audio/transcriptions', true);
    if (resp.status === 404) {
      // Older whisper.cpp or a server that only exposes /inference.
      resp = await post('/inference', false);
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new LMStudioError(
        `STT ${resp.status} from ${this.baseUrl} (${detail.slice(0, 200) || 'no body'})`,
      );
    }
    const body = (await resp.json()) as {
      text: string;
      segments?: { start: number; end: number; text: string }[];
    };
    return { text: body.text, segments: body.segments ?? [] };
  }

  async chat(input: ChatInput): Promise<string> {
    // 10-minute ceiling per attempt. Summarizing / extracting on a local model
    // routinely runs several minutes for long transcripts. One retry on
    // transient network failure — LM Studio occasionally drops mid-stream
    // connections between pipeline stages (the socket recovers within a
    // second or two). We don't retry aborts / 4xx / 5xx, only true network
    // failures, so we're not masking legit server errors.
    const attempt = async (): Promise<Response> => fetchWithDispatcher(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          temperature: input.temperature ?? 0.2,
          max_tokens: input.maxTokens,
        }),
        signal: AbortSignal.timeout(10 * 60 * 1000),
        dispatcher: getSlowLLMAgent(),
      },
    );

    let resp: Response;
    try {
      resp = await attempt();
    } catch (e) {
      const isAbort = e instanceof Error && e.name === 'AbortError';
      if (isAbort) {
        throw new LMStudioError(
          'LM Studio chat timed out after 10 minutes — model may be too large for this transcript',
          e,
        );
      }
      // Network hiccup — pause and retry once. If the second attempt still
      // blows up, surface the underlying error cause in the message so the
      // user isn't staring at a generic "network".
      await new Promise((r) => setTimeout(r, 2000));
      try {
        resp = await attempt();
      } catch (e2) {
        const cause = describeFetchError(e2);
        throw new LMStudioError(
          `LM Studio chat failed after retry (${cause}). ` +
            `Check LM Studio is running, a model is loaded, and the server tab is enabled.`,
          e2,
        );
      }
    }
    if (!resp.ok) throw new LMStudioError(`LM Studio ${resp.status} on /v1/chat/completions`);
    const body = (await resp.json()) as {
      choices: { message: { content: string; reasoning_content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content ?? '';
    // Empty content with a populated reasoning_content usually means the model
    // crashed mid-generation — on Apple Silicon this is almost always the
    // Metal OOM path, where LM Studio returns a 200 with a truncated response
    // because the GPU command buffer died. Gemma-31b on a 13k-token transcript
    // is the canonical trigger. Surface a specific error so the user knows to
    // switch to a smaller model (qwen3.5-9b, nemotron-3-nano-4b) rather than
    // chasing a "network" red herring.
    if (content.trim() === '') {
      const partial = body.choices?.[0]?.message?.reasoning_content ?? '';
      throw new LMStudioError(
        `LM Studio returned empty content — the model likely ran out of GPU memory ` +
          `mid-generation. Try a smaller model in Settings (e.g. qwen3.5-9b). ` +
          (partial ? `Partial output: "${partial.slice(0, 80)}…"` : ''),
      );
    }
    return stripThinking(content);
  }
}

// Reasoning models (Qwen3, DeepSeek-R1, gpt-oss, etc.) emit their chain of
// thought in <think>…</think> blocks. LM Studio returns the full text
// including those blocks. Strip them so summaries and action items aren't
// polluted with reasoning. Also drop an unclosed trailing <think> (happens
// on truncation / mid-stream).
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}
