import { z } from 'zod';
import { fetchWithSlowAgent } from '../lib/slow-fetch.js';

export const DiarSegmentSchema = z.object({
  start: z.number(), end: z.number(), speaker: z.string(), embedding: z.array(z.number()),
});
export const DiarResponseSchema = z.object({
  segments: z.array(DiarSegmentSchema),
  num_speakers: z.number().int(),
});
export type DiarResponse = z.infer<typeof DiarResponseSchema>;

export class DiarizationError extends Error {}

export class DiarizationClient {
  constructor(public readonly baseUrl: string) {}

  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  }

  async diarize(audioPath: string): Promise<DiarResponse> {
    // Pyannote on a 60-90 min meeting can hold the connection open for
    // 5-10 minutes before sending the first response byte. Plain `fetch`
    // gets killed by undici's default 5-min headersTimeout long before
    // our AbortSignal fires, surfacing as "fetch failed" with no detail.
    // The slow-agent dispatcher bumps both header and body timeouts
    // well past the 30-min user-facing ceiling.
    let resp: Response;
    try {
      resp = await fetchWithSlowAgent(`${this.baseUrl}/diarize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio_path: audioPath }),
        signal: AbortSignal.timeout(30 * 60 * 1000),
      });
    } catch (e) {
      throw new DiarizationError(`Diarization sidecar unreachable: ${(e as Error).message}`);
    }
    if (!resp.ok) throw new DiarizationError(`Sidecar ${resp.status}: ${await resp.text()}`);
    const body = await resp.json();
    return DiarResponseSchema.parse(body);
  }
}
