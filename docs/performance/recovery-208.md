# Recovery preview and trimming (#208)

The recovery row now exposes preview/trim, Finder, Dismiss and full recovery
at all widths. Its inline editor uses seconds for start/end, playback-position
shortcuts, validation, busy states and inline error feedback. Trimming writes
a uniquely named recovered copy; the original is never overwritten. ffmpeg
stream-copy boundaries are packet-aligned rather than sample-exact.

The backend selects the same usable mixed/microphone/system file for preview
and trimming, validates ranges, and serializes mutations per recovery ID.
The optional start argument defaults to zero for existing API callers.
The `recovery-audio` media scheme resolves IDs through the recovery service;
it does not accept arbitrary renderer paths. Files stream with byte-range
support rather than being loaded into IPC buffers. Web security remains enabled.

## Verification

- Production build and standalone renderer TypeScript check.
- Full Vitest suite with isolated fork workers: 732 passed, 2 opt-in tests
  skipped, 105 files passed.
- `MN_RECOVERY_TRIM_REAL=1 npx vitest run electron/main/recording/recovery-trim.test.ts`:
  14 passed, including a real M4A trim from 1 to 3 seconds, output duration
  between 1.8 and 2.2 seconds, and byte-identical original preservation.
- `npm run build && node_modules/.bin/electron scripts/recovery-media-smoke.cjs`:
  generated WAV loaded successfully from an HTTP renderer origin with default
  web security; bounded byte-range request returned 206 and the exact 56 bytes.
  Uses a temporary isolated profile, no real recordings.
- Direct handler tests cover full, bounded, open-ended and suffix ranges,
  invalid ranges and unknown IDs/hosts.
- Browser UI check in a 360px-wide fixture: actions wrap visibly, invalid range
  disables saving, valid range updates the kept duration, and simulated disk-full
  feedback retains the range for retry. This check used mock IPC and synthetic
  data; it did not modify user recordings. Temporary fixture removed afterward.
- Independent review: original direct-file preview issue corrected with scoped
  streaming; no remaining blocking findings.

The existing Vite >500 kB bundle warning remains. No dependencies were added.
