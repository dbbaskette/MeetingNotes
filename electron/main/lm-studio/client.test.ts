import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LMStudioClient, stripThinking, looksDegenerate, parseChatErrorBody, CONTEXT_OVERFLOW_MARKER } from './client.js';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('LMStudioClient.listModels', () => {
  it('returns model IDs from /v1/models', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.1-8b' }],
        }),
        { status: 200 },
      ),
    );
    const c = new LMStudioClient('http://localhost:1234');
    expect(await c.listModels()).toEqual(['whisper-large-v3', 'llama-3.1-8b']);
  });

  it('throws descriptive error on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const c = new LMStudioClient('http://localhost:1234');
    await expect(c.listModels()).rejects.toThrow(/LM Studio/);
  });
});

describe('LMStudioClient.chat', () => {
  it('POSTs JSON to /v1/chat/completions and returns assistant content', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Summary text' } }],
        }),
        { status: 200 },
      ),
    );
    const c = new LMStudioClient('http://localhost:1234');
    const result = await c.chat({
      model: 'llama-3.1-8b',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
    });
    expect(result).toBe('Summary text');
  });

  it('sends reasoning_effort=none and chat_template_kwargs when disableThinking is set', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200 },
      ),
    );
    const c = new LMStudioClient('http://localhost:1234');
    await c.chat({
      model: 'thinkingmachines/inkling-2-mini',
      messages: [{ role: 'user', content: 'hi' }],
      disableThinking: true,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      reasoning_effort?: string;
      chat_template_kwargs?: { enable_thinking?: boolean; reasoning_effort?: string };
    };
    expect(body.reasoning_effort).toBe('none');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false, reasoning_effort: 'none' });
  });

  it('sends reasoning_effort cap (minimal/low) without enable_thinking=false', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200 },
      ),
    );
    const c = new LMStudioClient('http://localhost:1234');
    await c.chat({
      model: 'thinkingmachines/inkling-2-mini',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'minimal',
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      reasoning_effort?: string;
      chat_template_kwargs?: { enable_thinking?: boolean; reasoning_effort?: string };
    };
    expect(body.reasoning_effort).toBe('minimal');
    expect(body.chat_template_kwargs).toEqual({ reasoning_effort: 'minimal' });
  });

  it('omits reasoning_effort and chat_template_kwargs entirely when default/unset', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200 },
      ),
    );
    const c = new LMStudioClient('http://localhost:1234');
    await c.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('chat_template_kwargs');
  });

  it('strips <think>…</think> blocks from reasoning-model output', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '<think>the user wants a summary. I should focus on…</think>\n\n## Overview\nReal content here.',
            },
          }],
        }),
        { status: 200 },
      ),
    );
    const c = new LMStudioClient('http://localhost:1234');
    const result = await c.chat({
      model: 'qwen3-14b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).not.toMatch(/<think>/);
    expect(result).toContain('## Overview');
  });
});

describe('LMStudioClient.chat — timeout & runaway handling', () => {
  it('fails FAST on an AbortSignal timeout (DOMException "TimeoutError") without retrying', async () => {
    // AbortSignal.timeout() rejects with a TimeoutError, NOT an AbortError. The
    // client must treat that as a hard timeout (fail fast), not a transient
    // network blip to retry — retrying just doubles a 10-minute wait.
    const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    fetchMock.mockRejectedValue(timeoutErr);
    const c = new LMStudioClient('http://localhost:1234');
    await expect(
      c.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on a timeout
  });

  it('reports a REASONING runaway (empty content, budget spent thinking) — not a GPU-memory error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'length',
              message: {
                role: 'assistant',
                content: '',
                reasoning_content: 'Goal: extract action items from the transcript. '.repeat(300),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const c = new LMStudioClient('http://localhost:1234');
    const err: Error = await c
      .chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e) => e);
    expect(err.message).toMatch(/reasoning|thinking|no answer/i);
    expect(err.message).not.toMatch(/GPU memory/i);
  });

  it('still reports a true OOM when BOTH content and reasoning come back empty', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', reasoning_content: '' } }],
        }),
        { status: 200 },
      ),
    );
    const c = new LMStudioClient('http://localhost:1234');
    const err: Error = await c
      .chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e) => e);
    expect(err.message).toMatch(/GPU memory/i);
  });

  // Gemma 4's reasoning length is intermittent/heavy-tailed: most samples
  // reason a few hundred words and answer fine, but one occasionally spirals
  // past the token budget and returns empty content. It can't be suppressed
  // (Gemma ignores enable_thinking and has no thinking-budget knob), so the
  // fix is to re-sample the rare spiral rather than hard-fail.
  const reasoningRunaway = () =>
    new Response(
      JSON.stringify({
        choices: [{
          finish_reason: 'length',
          message: { role: 'assistant', content: '', reasoning_content: 'thinking about the meeting. '.repeat(300) },
        }],
      }),
      { status: 200 },
    );
  const goodSummary = () =>
    new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '## Overview\nAll good.' } }],
      }),
      { status: 200 },
    );

  it('re-samples past an intermittent reasoning runaway when resampleRetries > 0', async () => {
    fetchMock.mockResolvedValueOnce(reasoningRunaway()).mockResolvedValueOnce(goodSummary());
    const c = new LMStudioClient('http://localhost:1234');
    const result = await c.chat({
      model: 'm', messages: [{ role: 'user', content: 'hi' }], resampleRetries: 2,
    });
    expect(result).toContain('## Overview');
    expect(fetchMock).toHaveBeenCalledTimes(2); // spiral, then a clean re-sample
  });

  it('surfaces the reasoning error only after exhausting resampleRetries', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(reasoningRunaway())); // fresh response per call; every sample spirals
    const c = new LMStudioClient('http://localhost:1234');
    const onResample = vi.fn();
    const err: Error = await c
      .chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], resampleRetries: 2, onResample })
      .catch((e) => e);
    expect(err.message).toMatch(/no answer|thinking/i);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(onResample).toHaveBeenCalledTimes(2);
  });

  it('re-samples at a higher temperature so a temperature-0 caller actually diverges', async () => {
    // Extract runs at temperature 0 (deterministic), so a plain re-issue would
    // reproduce the exact same spiral — measured 4/4 identical 1157-word spirals
    // on the real failing summary. The retry must raise the temperature to break
    // the deterministic path.
    fetchMock.mockResolvedValueOnce(reasoningRunaway()).mockResolvedValueOnce(goodSummary());
    const c = new LMStudioClient('http://localhost:1234');
    await c.chat({
      model: 'm', temperature: 0, messages: [{ role: 'user', content: 'hi' }], resampleRetries: 1,
    });
    const firstBody = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    const retryBody = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body);
    expect(firstBody.temperature).toBe(0); // original request unchanged
    expect(retryBody.temperature).toBeGreaterThanOrEqual(0.5); // retry diverges
  });

  it('does NOT retry by default so the health-check canary still detects a loop', async () => {
    fetchMock.mockResolvedValueOnce(reasoningRunaway());
    const c = new LMStudioClient('http://localhost:1234');
    await expect(
      c.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/no answer|thinking/i);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no resample without the opt-in
  });

  it('does NOT re-sample a true OOM even with resampleRetries set', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(
      new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', reasoning_content: '' } }] }),
        { status: 200 },
      ),
    ));
    const c = new LMStudioClient('http://localhost:1234');
    const err: Error = await c
      .chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], resampleRetries: 2 })
      .catch((e) => e);
    expect(err.message).toMatch(/GPU memory/i);
    expect(fetchMock).toHaveBeenCalledTimes(1); // OOM isn't a re-sampleable condition
  });

  it('rejects degenerate / looping output with an actionable error', async () => {
    const loop = '## Overview\n' + 'much more detailed and '.repeat(900);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: loop } }] }),
        { status: 200 },
      ),
    );
    const c = new LMStudioClient('http://localhost:1234');
    await expect(
      c.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/repetit|looping/i);
  });

  it('aborts immediately without 2s retry or false timeout when caller signal aborts with custom Error', async () => {
    const controller = new AbortController();
    const cancelReason = new Error('Processing cancelled by you.');
    fetchMock.mockImplementationOnce(async () => {
      controller.abort(cancelReason);
      throw cancelReason;
    });
    const c = new LMStudioClient('http://localhost:1234');
    const started = Date.now();
    await expect(
      c.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }),
    ).rejects.toThrow('Processing cancelled by you.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('uses the configured provider label in error messages', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const c = new LMStudioClient('http://127.0.0.1:11434', () => 'Ollama');
    await expect(c.listModels()).rejects.toThrow(/Ollama unreachable at http:\/\/127\.0\.0\.1:11434/);
  });
});

describe('LMStudioClient.chat — HTTP errors', () => {
  const chat = () =>
    new LMStudioClient('http://localhost:1234').chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

  it('explains a context-size 400 with the prompt and loaded-context sizes', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: 'request (17447 tokens) exceeds the available context size (16384 tokens), try increasing it',
            type: 'exceed_context_size_error',
            n_prompt_tokens: 17447,
            n_ctx: 16384,
          },
        }),
        { status: 400 },
      ),
    );
    const err = await chat().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('The prompt is 17,447 tokens but the model is loaded with 16,384 tokens of context');
    expect(msg).toContain(CONTEXT_OVERFLOW_MARKER);
    expect(msg).toContain('Settings → Advanced');
    expect(msg).toContain('LM Studio 400 on /v1/chat/completions');
    expect(fetchMock).toHaveBeenCalledTimes(1); // a 400 is never retried
  });

  it('recognises the overflow from the message text when only a string error is sent', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'request (20000 tokens) exceeds the available context size (8192 tokens), try increasing it' }),
        { status: 400 },
      ),
    );
    await expect(chat()).rejects.toThrow(/20,000 tokens but the model is loaded with 8,192 tokens of context/);
  });

  it('keeps LM Studio\'s message for other 4xx/5xx errors', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Model "m" not found' } }), { status: 404 }),
    );
    await expect(chat()).rejects.toThrow('LM Studio 404 on /v1/chat/completions: Model "m" not found');
  });

  it('falls back to the bare status when the body is empty', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(chat()).rejects.toThrow(/^LM Studio 500 on \/v1\/chat\/completions$/);
  });
});

describe('parseChatErrorBody', () => {
  it('reads structured llama.cpp fields', () => {
    expect(
      parseChatErrorBody(JSON.stringify({ error: { message: 'x', type: 'exceed_context_size_error', n_prompt_tokens: 5, n_ctx: 4 } })),
    ).toEqual({ message: 'x', type: 'exceed_context_size_error', promptTokens: 5, contextTokens: 4 });
  });

  it('keeps a non-JSON body as the message', () => {
    expect(parseChatErrorBody('upstream exploded').message).toBe('upstream exploded');
  });
});

describe('looksDegenerate', () => {
  it('flags a low-variety repetition loop', () => {
    expect(looksDegenerate('own-the-cluster-as-a-service. '.repeat(700))).toBe(true);
    expect(looksDegenerate('much more detailed and '.repeat(900))).toBe(true);
  });
  it('passes a long, lexically varied summary', () => {
    const varied = Array.from({ length: 600 }, (_, i) => `topic${i}`).join(' ');
    expect(looksDegenerate(varied)).toBe(false);
  });
  it('does not judge short outputs (e.g. a small JSON action-item list)', () => {
    expect(looksDegenerate('[{"text":"File the spec","owner":"Me","due_date":null}]')).toBe(false);
  });
});

describe('stripThinking', () => {
  it('removes closed <think> blocks', () => {
    expect(stripThinking('<think>reasoning</think>hello')).toBe('hello');
  });
  it('removes multiple blocks', () => {
    expect(stripThinking('<think>a</think>one<think>b</think>two')).toBe('onetwo');
  });
  it('drops an unclosed trailing <think> block', () => {
    expect(stripThinking('real content<think>truncated reasoning')).toBe('real content');
  });
  it('is a no-op for text without tags', () => {
    expect(stripThinking('## Overview\nstuff')).toBe('## Overview\nstuff');
  });
});
