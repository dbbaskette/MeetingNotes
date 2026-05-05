// electron/main/lib/slow-fetch.ts
//
// Shared undici dispatcher for HTTP calls that legitimately take many
// minutes to complete:
//
//   - LM Studio chat completions on a 13k-token transcript can run
//     several minutes for a 7-9B model on Apple Silicon.
//   - Whisper-server transcription of a 25-min WAV chunk takes 1-2 min.
//   - Pyannote diarization of a 90-min meeting takes 5-10 min before
//     it sends the first response byte.
//
// Node's bundled fetch (undici) has a default `headersTimeout` of 5
// minutes — it fires while the server is still doing the work and
// surfaces as "fetch failed" with no helpful detail. Our user-facing
// AbortSignal.timeout() is much higher, but it doesn't override
// undici's defaults; whichever fires first wins. We bump both
// `headersTimeout` and `bodyTimeout` well past any sensible AbortSignal
// ceiling so the AbortSignal is the thing that ends the call, not
// undici's defaults.
//
// Constructed lazily so test environments without an Agent (e.g.
// vitest's happy-dom) don't pay the construction cost.

import { Agent } from 'undici';

let agent: Agent | undefined;

/** Long-running-friendly undici dispatcher. Cached after first call. */
export function getSlowFetchAgent(): Agent {
  if (!agent) {
    agent = new Agent({
      // Keep both well above the longest legitimate AbortSignal we set
      // anywhere in the codebase (currently 30 min on diarize, 10 min
      // on chat). 35 minutes leaves headroom for both.
      headersTimeout: 35 * 60 * 1000,
      bodyTimeout: 35 * 60 * 1000,
      connectTimeout: 30 * 1000,
    });
  }
  return agent;
}

// `fetch`'s global TS signature doesn't expose undici's `dispatcher`
// option, even though Node's runtime fetch accepts it. Wrapping the
// cast keeps it in one place.
type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: Agent };

export function fetchWithSlowAgent(
  url: string,
  init: FetchInit = {},
): Promise<Response> {
  return fetch(url, {
    ...(init as Parameters<typeof fetch>[1]),
    // @ts-expect-error — the dispatcher field is undici-only.
    dispatcher: init.dispatcher ?? getSlowFetchAgent(),
  });
}
