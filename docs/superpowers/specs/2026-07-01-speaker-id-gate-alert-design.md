# Surface the "awaiting speaker ID" gate — Design

**Date:** 2026-07-01
**Status:** Draft

## Problem

The processing pipeline stops at `awaiting_speaker_id` and waits for the user to
confirm who each speaker is before it summarizes/extracts (`pipeline.ts`, the
gate at lines 199–205: `updateStage → 'awaiting_speaker_id'`, `updateStatus →
'awaiting_user'`, then `return`). Nothing proactively pulls the user back once
they've navigated away, so a meeting can sit blocked on a human for a long time
while the user believes it's still "processing."

The renderer already renders the parked state when the user happens to be looking
at the Library: an amber left edge, a "?" avatar, and a "NAME VOICES" status chip
(`LibraryRow.tsx`, `status === 'awaiting_user'`). But there is:

- **No app-level indicator** that draws the eye to a meeting needing input when it
  is not the row the user is scanning — no count, no "needs your input" affordance
  above the list.
- **No proactive nudge at all** when the app is backgrounded or the user is in a
  different view. macOS native notifications exist in the codebase
  (`electron/main/index.ts:430`, `new Notification({ title, body }).show()`, wired
  through the URL-scheme dispatcher's `notify`) but nothing fires one when a
  meeting enters the gate.

Note: this is strictly an **alerting** change. Suggesting *who* the speakers are is
a separate, already-planned effort (`2026-07-01-speaker-id-confidence-suggestions.md`);
this design does not touch identity suggestion.

## Decision

Fire a **single native macOS notification** the moment a meeting transitions into
`awaiting_speaker_id`, and add a **"needs your input" summary badge** to the Library
so the parked meeting is visible app-wide, not just when its row is on screen.

1. **State-entry hook (main).** The gate transition in `pipeline.ts` is the one true
   place a meeting enters `awaiting_speaker_id`. Add a `SpeakerGateListener` to
   `Pipeline` (mirroring the existing `onMeetingComplete` listener), fired exactly
   where the pipeline sets `awaiting_user` and returns. `index.ts` subscribes and
   drives the notification.

2. **Dedupe as a pure function.** Whether to notify is decided by a pure,
   fully-testable `shouldNotifyGate(meetingId, notified: Set<string>)` helper: notify
   iff the meeting id is not already in the "already-notified" set. The set is cleared
   for a meeting whenever it *leaves* the gate (the user continues, sets skip, or the
   meeting is re-run), so a genuine re-entry into the gate notifies again — but a
   duplicate transition for the same entry does not. This isolates all the logic worth
   testing away from the untestable Electron `Notification` call.

3. **Thin notification shell (main).** The actual `new Notification(...)` lives in a
   tiny wrapper matching the existing `index.ts:430` pattern, extended with a
   `click` handler that focuses the window and routes to the meeting. Not unit-tested;
   covered by a manual verification step.

4. **Click → focus + route to the meeting.** Reuse the exact path the URL-scheme
   dispatcher already uses: `focusMainWindow()` (raise/restore/show/focus the first
   window) then `emitOpenMeeting(meetingId)`, which broadcasts `mn:open-meeting` to
   all windows. The renderer already listens (`App.tsx:194`,
   `api.onOpenMeeting → setView({ kind: 'detail', id })`). No new IPC channel, no
   deeplink parsing — the notification click calls the same two functions inline.

5. **Library "needs your input" badge (renderer).** Add a small summary affordance at
   the top of the Library that appears when one or more meetings are `awaiting_user`,
   showing the count and, on click, selecting/scrolling to the first such meeting. The
   per-row treatment stays as-is; this is the app-wide "you have N meetings waiting on
   you" signal that today's UI lacks. Derived purely from the already-loaded
   `meetings` list (`status === 'awaiting_user'`) — no new data fetch.

### Considered alternatives

- **Notify from `meetings-repo.updateStatus` when status becomes `awaiting_user`:**
  the repo is a dumb persistence layer with no notion of Electron or windows, and
  `awaiting_user` is set from exactly one call site today. Coupling notifications to
  the storage layer would be a layering violation and would fire on any future writer
  of that status. Rejected — hook the pipeline, which owns the transition.
- **A recurring "you still have meetings waiting" reminder:** violates the explicit
  "avoid nagging — notify once per entry" requirement. Rejected.
- **Fire on every `onStatusChange`:** the pipeline's status listener is about queue
  motion (pause/resume/current-id), not per-meeting stage transitions, and would
  require the subscriber to diff state to detect a *new* gate entry. The dedicated
  `SpeakerGateListener` fires exactly once at the transition with the meeting id in
  hand. Rejected.

## Changes

### 1. `electron/main/pipeline/pipeline.ts` — a gate-entry listener

- Add `export type SpeakerGateListener = (meetingId: string) => void;` next to
  `MeetingCompleteListener`.
- Add a `gateListeners: Set<SpeakerGateListener>` and an
  `onAwaitingSpeakerId(cb): () => void` subscribe method, mirroring
  `onMeetingComplete` exactly (add/return-unsubscribe).
- In `process()`, inside the `if (s === 'awaiting_speaker_id')` block, immediately
  after `updateStatus(meetingId, 'awaiting_user')` and before `return`, fire the
  listeners in a try/catch-per-listener loop so a throwing listener can't break the
  pipeline (same isolation the existing `notify()` and complete-listener loops use).

### 2. `electron/main/pipeline/gate-alert.ts` — new, pure dedupe

- New tiny module exporting `shouldNotifyGate(meetingId, notified: Set<string>):
  boolean` and `clearGateNotified(meetingId, notified: Set<string>): void`.
- `shouldNotifyGate` returns `true` iff `meetingId` is absent from `notified`, and as
  a side effect adds it (so the caller doesn't have to remember to). Pure w.r.t.
  Electron; trivially unit-tested.
- `clearGateNotified` removes the id so a later genuine re-entry notifies again.

### 3. `electron/main/index.ts` — wire the hook to a native notification

- Keep a module-scoped `const gateNotified = new Set<string>()`.
- Subscribe: `pipeline.onAwaitingSpeakerId((meetingId) => { ... })`. In the callback:
  - `if (!shouldNotifyGate(meetingId, gateNotified)) return;`
  - Look up the meeting (`meetings.findById`) for its title; skip if missing.
  - Call a small local `notifyGate({ meetingId, title })` that builds a
    `new Notification({ title: 'MeetingNotes', body: \`"${title}" needs you to
    confirm speakers to keep processing\` })`, guards with
    `Notification.isSupported()`, and registers a `click` handler that runs
    `focusMainWindow()` then broadcasts `mn:open-meeting` (reusing the two functions
    already defined for the dispatcher — extract them to named consts so both the
    dispatcher wiring and this handler share them).
- Clear on leave: whenever the meeting exits the gate, call
  `clearGateNotified(meetingId, gateNotified)`. The exit points are the IPC handlers
  `continueFromSpeakerId`, `setSkipSpeakerId(skip=true)`, and `rerun` — but rather
  than touch each, clear on the *next* gate entry is insufficient (that's the dedupe
  itself). Instead clear inside the existing `pipeline.onStatusChange`/completion
  paths is also wrong (queue-level). The clean seam: clear in the same IPC handlers
  that unblock the gate. See §4.

### 4. `electron/main/ipc/handlers.ts` — clear the dedupe flag on unblock

- The handlers that move a meeting *out* of `awaiting_speaker_id`
  (`continueFromSpeakerId`, `setSkipSpeakerId` when `skip` is true, and `rerun` from a
  stage at/after the gate) each call `clearGateNotified(id, gateNotified)` (the set is
  passed into the handlers' dependency object, or exposed via a small setter). This is
  what makes a *real* re-entry (user un-skips, or re-runs the meeting and it parks
  again) notify a second time, while a duplicate transition for the same visit stays
  silent.

### 5. `electron/renderer/src/views/LibraryView.tsx` — "needs your input" summary badge

- Derive `awaitingCount = meetings.filter((m) => m.status === 'awaiting_user').length`
  from the already-loaded store (no fetch).
- When `awaitingCount > 0`, render a compact, amber, clickable banner/pill above the
  list: e.g. `N meeting(s) need you to name voices`. Clicking it opens the first
  `awaiting_user` meeting (`onOpen(firstAwaiting.id)`), reusing the row's existing
  open path.
- Uses the existing `status-warn*` tokens so it matches the row's amber treatment.

### 6. Tests

- `gate-alert.test.ts`: `shouldNotifyGate` returns true then false for the same id;
  true again after `clearGateNotified`; independent ids are independent.
- `pipeline.test.ts`: add a case that a meeting reaching `awaiting_speaker_id` fires
  the `onAwaitingSpeakerId` listener exactly once with the meeting id, and that a
  `skipSpeakerId` meeting does **not** fire it (it sails past the gate).
- `LibraryView.test.tsx` (or the existing Library test file, if present): the summary
  badge appears with the right count when meetings are `awaiting_user` and is absent
  otherwise.

## What does not change

The stage machine, the `awaiting_user` status, the per-row amber treatment in
`LibraryRow.tsx`, the URL-scheme dispatcher's own behavior, the speaker roster/
confirmation flow, and identity *suggestion* (separate plan). No new IPC event
channel is introduced — click routing reuses `mn:open-meeting`.

## Error handling

- `Notification.isSupported()` false (or `new Notification` throws) → log and no-op,
  exactly like `index.ts:430` today. The in-app badge still surfaces the gate.
- Meeting not found at notify time (deleted between transition and callback) → skip
  silently; nothing to route to.
- A throwing gate listener is isolated per-listener so it can't wedge the pipeline.

## Testing strategy

Unit tests as in §6 (vitest). The native `Notification` construction and its `click`
handler are deliberately kept in a thin untested shell in `index.ts`; the decision
logic (`shouldNotifyGate`/`clearGateNotified`) and the transition hook
(`onAwaitingSpeakerId`) are the tested seams.

**Manual verification:** process a real meeting with `skipSpeakerId` off and the app
backgrounded; confirm exactly one notification appears when it reaches the gate,
clicking it raises the window and lands on that meeting's detail view, and continuing
past the gate then re-running the meeting into the gate again produces a second
notification (no notification fires on incidental re-renders in between).
