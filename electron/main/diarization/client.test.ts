import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DiarizationClient } from './client';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe('DiarizationClient', () => {
  it('health returns true when sidecar responds ok', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    const c = new DiarizationClient('http://127.0.0.1:8765');
    expect(await c.health()).toBe(true);
  });

  it('health returns false on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const c = new DiarizationClient('http://127.0.0.1:8765');
    expect(await c.health()).toBe(false);
  });

  it('diarize POSTs audio path and returns segments', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      segments: [{ start: 0, end: 1, speaker: 'SPEAKER_00', embedding: new Array(512).fill(0) }],
      num_speakers: 1,
    }), { status: 200 }));
    const c = new DiarizationClient('http://127.0.0.1:8765');
    const result = await c.diarize('/x/a.mp3');
    expect(result.segments[0]!.speaker).toBe('SPEAKER_00');
    expect(result.segments[0]!.embedding).toHaveLength(512);
    expect(result.num_speakers).toBe(1);
  });
});
