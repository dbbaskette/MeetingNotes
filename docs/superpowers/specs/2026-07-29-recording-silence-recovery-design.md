# Recording Silence Recovery Design

## Goal

Prevent forgotten recordings from running indefinitely, ensure a recording
that initially appears unfinished is cataloged after finalization, and reduce
Gemma 4 action-extraction failures caused by an undersized output allowance.

## Scope

This change covers three connected failure modes:

1. A built-in recording continues after five minutes without audible input.
2. The library permanently suppresses an M4A after probing it before its
   `moov` atom has been finalized.
3. Action-item extraction exhausts a 4,000-token allowance while Gemma 4 is
   still reasoning, even though a later re-sample often succeeds.

The change does not add a configurable timeout, infer that a native meeting app
has ended, delete long recordings, or change the summary-stage token allowance.

## Recording Watchdog

The watchdog belongs in `RecordingManager`, not in the renderer. This keeps it
active when the MeetingNotes window is hidden, showing a different view, or
temporarily unavailable.

Each recording session tracks its last audible observation. A peak strictly
above `-50 dBFS` is audible. Starting a session arms a five-minute timer even if
the helper never emits a level event. Every audible peak resets the timer to a
full five minutes. Quiet peaks do not reset it.

When the timer expires, `RecordingManager` calls the same `stop(sessionId)`
method used by a manual stop. That path sends `SIGTERM`, waits for helper exit,
uses the existing five-second `SIGKILL` fallback, finalizes the recording
session row, and removes the in-memory session. The resulting M4A therefore has
the same lifecycle as a manually stopped recording.

The stop path must be idempotent for concurrent manual and automatic requests.
Once a session enters `stopping`, a second stop request waits for or returns
with the existing stop rather than signaling, finalizing, or deleting the
session twice. All silence timers are cleared on manual stop, automatic stop,
helper exit, startup failure, and manager teardown.

The manager emits or logs an explicit automatic-stop reason containing the
session ID and five-minute silence duration. Existing state-change events still
drive the dock badge and live-recording UI.

The renderer retains its short no-audio warning. Its current twenty-second
warning is useful immediate feedback and is separate from the five-minute
automatic-stop policy.

## Library Rediscovery

The observed long recording stopped producing audio at approximately 3:08 PM,
which made its size appear stable while the helper process remained alive. The
library watcher emitted the new path, `ffprobe` failed because the M4A had no
finalized `moov` atom, and the watcher permanently remembered the path as
emitted. Finalization the next morning changed the file, but only `add` events
were observed and the path could not be emitted again.

The watcher will observe both stable `add` and stable `change` events. A
successfully cataloged path remains deduplicated. When cataloging fails, the
consumer releases that path from the watcher's emitted set. A later stable
change—especially the helper's finalization write—can then emit the path again.

The meetings repository remains the authoritative second deduplication layer.
Before inserting, cataloging still checks `findByAudioPath`, so a change event
after successful insertion cannot create a duplicate meeting.

Permanent corruption remains visible as a logged discovery failure. The system
does not poll a static corrupt file forever; it retries only when the file
actually changes or the app restarts and performs its existing initial scan.

## Action-Extraction Budget

Yesterday's logs and the recovered meeting consistently showed empty-content
failures at roughly 2,200 reasoning words with `max_tokens: 4000`. The recovered
meeting exhausted that allowance twice and succeeded on its third sample.
Summary generation completed normally with its existing 8,000-token allowance.

`EXTRACT_MAX_TOKENS` increases from `4000` to `6000`. The current two
temperature-shifted re-samples remain in place:

- The initial extraction remains deterministic at temperature `0`.
- A reasoning-only empty result raises retry temperature to at least `0.6`.
- Up to two re-samples are allowed.
- True empty-output/OOM failures, HTTP errors, timeouts, and repetitive output
  retain their existing handling.

This gives Gemma 4 room to finish the measured reasoning tail without turning
every extraction into additional requests. The existing retry mechanism still
covers intermittent longer spirals.

## Data Flow

1. The audio helper emits peak levels to `RecordingManager`.
2. An audible peak resets the session's five-minute watchdog.
3. Five quiet minutes invoke the normal stop path.
4. Helper finalization writes the M4A metadata and closes the file.
5. `LibraryWatcher` observes a stable add or change.
6. Cataloging probes the file and inserts the meeting.
7. A failed probe releases watcher deduplication so finalization can trigger a
   later attempt.
8. Processing uses the existing transcription, diarization, merge, speaker,
   summary, and extraction stages.
9. Extraction allows 6,000 output tokens and retains two reasoning re-samples.

## Error Handling

- An automatic stop failure is logged with its session ID and leaves the
  existing recording error/recovery behavior intact.
- Concurrent stops cannot finalize the same session twice.
- Helper self-exit clears the watchdog before finalizing the session.
- Failed discovery logs the probe error and makes the path eligible for a
  future change event.
- Successful discovery remains deduplicated across add, change, and restart
  scans.
- Extraction failures retain their existing actionable user-facing messages
  after the larger allowance and retries are exhausted.

## Testing

### Recording manager

- A session with no audible levels automatically stops after five minutes.
- A session with no level events at all still automatically stops.
- An audible peak before expiry resets the full five-minute window.
- A peak at exactly `-50 dBFS` does not reset the timer.
- Manual stop clears the watchdog.
- Manual stop racing with watchdog expiry signals and finalizes once.
- Helper self-exit clears the watchdog and finalizes once.

Tests use injected time and timer dependencies; they do not sleep.

### Library watcher

- Stable `change` events are observed for supported non-stem audio.
- A successfully emitted path is not emitted again on change.
- Releasing a failed path permits a later change event to emit it again.
- Stem artifacts remain excluded on both add and change.

### Extraction

- The extraction request sends `maxTokens: 6000`.
- Existing reasoning re-sample count and temperature behavior remain covered by
  the LM Studio client and extraction tests.

### Verification

Run targeted recording-manager, watcher, extraction, and LM Studio client tests
after each functional slice. Run the complete relevant test suite and build
once before reporting completion.

## Recovery Record

The affected July 28 recording was preserved unchanged and copied to a trimmed
mixed/system/voice set ending at 3:30 PM Eastern. The trimmed meeting
`ezxocmlb`, titled `Spring Swat 072826`, completed processing with a 6,202
character summary and seven action items. Its extraction reproduced two
4,000-token reasoning failures before the final built-in sample succeeded.
