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

/** Substring of the reasoning-runaway error thrown by chat() below. The
 *  health-check IPC handler gates its "loops" verdict on it, and the renderer
 *  keeps a hand-copied twin (electron/renderer/src/lib/reasoning-loop.ts —
 *  renderer code can't import main-process modules) to gate the failure
 *  banner's recovery controls. A parity test keeps the copies in sync. */
export const REASONING_LOOP_MARKER = 'spent its entire token budget';

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
  /** Turn the model's "thinking" / chain-of-thought OFF. Reasoning-capable
   *  local models (Gemma 4, Qwen3, DeepSeek-R1, gpt-oss, …) otherwise burn
   *  their whole token budget in `reasoning_content` and return empty
   *  `content` — looking like an out-of-memory failure when it isn't. When
   *  true we pass `chat_template_kwargs: { enable_thinking: false }`, which
   *  LM Studio's OpenAI-compatible API forwards to the model's chat template
   *  (the only reliable lever — Gemma 4 has no LM Studio UI toggle). Models
   *  whose template doesn't reference the kwarg simply ignore it. */
  disableThinking?: boolean;
  /** How many times to RE-ISSUE the request when the model returns an
   *  intermittent "reasoning runaway" (empty content because it spent the
   *  whole budget thinking). Gemma 4 can't be told to stop thinking (it
   *  ignores every suppression knob and has no thinking-budget parameter),
   *  but its reasoning length is heavy-tailed — most samples answer fine and
   *  only the occasional one spirals past the budget. Re-sampling (callers use
   *  temperature > 0) clears the spiral the vast majority of the time. Default
   *  0: unset callers — notably the model health-check canary — still surface
   *  the loop so it can be detected/reported. Only the reasoning-runaway case
   *  is re-sampled; a true OOM (empty reasoning too) is not. */
  resampleRetries?: number;
  /** Called before each re-sample with the 1-based retry number and the
   *  reasoning-word count of the spiral that triggered it, so callers can log
   *  the otherwise-invisible retry. */
  onResample?: (retry: number, reasoningWords: number) => void;
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
    // Outer loop re-samples the intermittent reasoning runaway (see
    // resampleRetries). Each pass is a fresh request; callers that re-sample
    // use temperature > 0, so the retry gets a different generation and the
    // spiral (a sampling tail event) almost always clears.
    const maxResample = Math.max(0, input.resampleRetries ?? 0);
    for (let attemptNo = 0; ; attemptNo++) {
      const resp = await this.requestChatCompletion(input);
      if (!resp.ok) throw new LMStudioError(`LM Studio ${resp.status} on /v1/chat/completions`);
      const body = (await resp.json()) as {
        choices: { finish_reason?: string; message: { content: string; reasoning_content?: string } }[];
      };
      const choice = body.choices?.[0];
      const content = choice?.message?.content ?? '';
      // An empty answer has two very different causes, and conflating them sent
      // users chasing the wrong fix ("out of GPU memory" when memory was fine):
      //
      //  1. Reasoning runaway. A reasoning model burns its whole token budget in
      //     reasoning_content ("thinking") and never emits an answer — looping on
      //     a messy transcript. Observed as finish_reason="length" (when capped)
      //     or a huge reasoning_content with finish_reason="stop" (30k+ thinking
      //     tokens, zero content). Intermittent, so we re-sample it before
      //     surfacing the failure (below); the fix of last resort is a
      //     non-reasoning model — NOT a smaller one.
      //  2. Genuine mid-generation crash (Metal GPU OOM), where BOTH content and
      //     reasoning come back empty. Here a smaller model genuinely helps, and
      //     re-sampling won't — so this case is never retried.
      if (content.trim() === '') {
        const reasoning = (choice?.message?.reasoning_content ?? '').trim();
        const reasoningWords = reasoning ? reasoning.split(/\s+/).length : 0;
        if (choice?.finish_reason === 'length' || reasoningWords > 200) {
          if (attemptNo < maxResample) {
            input.onResample?.(attemptNo + 1, reasoningWords);
            continue; // re-sample the spiral
          }
          throw new LMStudioError(
            `LM Studio produced no answer — the model ${REASONING_LOOP_MARKER} ` +
              `"thinking" (~${reasoningWords} reasoning words) without writing any output. ` +
              `This reasoning model (e.g. Gemma 4, Qwen3) is looping on this transcript. ` +
              `Turn ON "Disable model thinking" in Settings so MeetingNotes tells the model ` +
              `to skip its chain-of-thought, then retry. (If it's already on, this model ` +
              `ignores the thinking toggle — switch to a non-reasoning model in LM Studio.)` +
              (reasoning ? ` Reasoning began: "${reasoning.slice(0, 80)}…"` : ''),
          );
        }
        throw new LMStudioError(
          `LM Studio returned empty content — the model likely ran out of GPU memory ` +
            `mid-generation. Try a smaller model in Settings (e.g. qwen3.5-9b).`,
        );
      }
      const cleaned = stripThinking(content);
      // A local model under memory pressure (or on a messy transcript) can
      // degenerate into a repetition loop — emitting the same phrase thousands of
      // times until the request times out. With no max_tokens cap that runs for
      // the full 10-minute ceiling; even with one it produces unusable garbage.
      // Catch it here and fail with an actionable message instead of writing a
      // looping "summary" to disk.
      if (looksDegenerate(cleaned)) {
        const words = cleaned.trim().split(/\s+/).length;
        throw new LMStudioError(
          `LM Studio returned repetitive, looping output (${words} words, almost no ` +
            `lexical variety) — the model degenerated mid-generation. This is usually ` +
            `memory pressure or too-long a context. Free memory, lower the model's ` +
            `context length, or switch to a smaller model in Settings.`,
        );
      }
      return cleaned;
    }
  }

  /** One chat-completion HTTP request with the existing timeout + single
   *  network retry. Throws a fatal LMStudioError on timeout or a network
   *  failure that survives the retry. Separated from {@link chat} so the
   *  re-sample loop can re-issue it cleanly. */
  private async requestChatCompletion(input: ChatInput): Promise<Response> {
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
          // Only emit the key when we actually want thinking off, so a
          // request to a non-reasoning model stays byte-for-byte unchanged.
          ...(input.disableThinking
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {}),
        }),
        signal: AbortSignal.timeout(10 * 60 * 1000),
        dispatcher: getSlowLLMAgent(),
      },
    );

    let resp: Response;
    try {
      resp = await attempt();
    } catch (e) {
      // `AbortSignal.timeout()` rejects with a DOMException named "TimeoutError"
      // (NOT "AbortError"), so checking only AbortError let a genuine 10-minute
      // timeout fall through to the network-retry branch below — doubling the
      // wait to ~20 minutes and surfacing a misleading "is LM Studio running?"
      // message. Treat both names as a hard timeout and fail fast.
      const isTimeout =
        e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      if (isTimeout) {
        throw new LMStudioError(
          'LM Studio chat timed out after 10 minutes. The model stalled or ran away ' +
            '(repetitive/looping output) — usually a sign of memory pressure or too-long ' +
            "a context. Free memory, lower the model's context length, or pick a smaller " +
            'model in Settings.',
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
    return resp;
  }
}

// Detect degenerate "stuck in a loop" model output — the same short phrase
// repeated until the token budget (or request timeout) runs out. Such loops
// collapse lexical variety to near zero, so a low unique-word ratio over a long
// output is a reliable signal. Short outputs (a one-line answer, a small JSON
// action-item array) are left unjudged so we never false-positive on them.
export function looksDegenerate(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length < 400) return false;
  const uniqueRatio = new Set(words).size / words.length;
  return uniqueRatio < 0.18;
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
