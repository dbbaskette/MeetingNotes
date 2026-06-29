import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LMStudioClient, stripThinking, looksDegenerate } from './client.js';

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

describe('LMStudioClient.transcribe', () => {
  it('POSTs multipart form to /v1/audio/transcriptions and returns segments', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          text: 'hello world',
          segments: [{ start: 0, end: 1, text: 'hello world' }],
        }),
        { status: 200 },
      ),
    );
    const c = new LMStudioClient('http://localhost:1234');
    const result = await c.transcribe({
      audioPath: '/tmp/x.mp3',
      model: 'whisper-large-v3',
      language: 'en',
      readFile: async () => new Uint8Array([1, 2, 3]),
    });
    expect(result.text).toBe('hello world');
    expect(result.segments[0]!.start).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:1234/v1/audio/transcriptions');
    expect((init as RequestInit).method).toBe('POST');
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
