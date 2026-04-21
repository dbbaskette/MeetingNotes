import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LMStudioClient, stripThinking } from './client.js';

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
