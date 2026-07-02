# Surface the "awaiting speaker ID" gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a meeting enters `awaiting_speaker_id`, surface it: fire one native macOS notification (clicking it focuses the app on that meeting) and show an app-wide "needs your input" badge in the Library — notify once per entry into the gate, never nag.

**Architecture:** Per the approved spec (`docs/superpowers/specs/2026-07-01-speaker-id-gate-alert-design.md`): (1) a pure `shouldNotifyGate`/`clearGateNotified` dedupe module, (2) a `SpeakerGateListener` on `Pipeline` fired exactly at the gate transition in `process()`, (3) a thin untested `Notification` shell in `index.ts` whose `click` reuses the dispatcher's `focusMainWindow` + `mn:open-meeting` route, (4) clearing the dedupe flag in the three IPC handlers that unblock the gate, and (5) a Library summary badge derived from the already-loaded meeting list. No new IPC channel.

**Tech Stack:** TypeScript (Electron main process), React (renderer), vitest.

---

### Task 1: Pure gate-notification dedupe module

**Files:**
- Create: `electron/main/pipeline/gate-alert.ts`
- Create: `electron/main/pipeline/gate-alert.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/main/pipeline/gate-alert.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldNotifyGate, clearGateNotified } from './gate-alert.js';

describe('shouldNotifyGate', () => {
  it('notifies the first time a meeting enters the gate, then suppresses repeats', () => {
    const notified = new Set<string>();
    // First entry into awaiting_speaker_id for this meeting — notify.
    expect(shouldNotifyGate('m1', notified)).toBe(true);
    // A duplicate transition for the SAME visit must not notify again.
    expect(shouldNotifyGate('m1', notified)).toBe(false);
  });

  it('notifies again after the meeting leaves the gate (genuine re-entry)', () => {
    const notified = new Set<string>();
    expect(shouldNotifyGate('m1', notified)).toBe(true);
    // User continued / un-skipped / re-ran — the flag is cleared on unblock.
    clearGateNotified('m1', notified);
    // A real re-entry into the gate deserves a fresh notification.
    expect(shouldNotifyGate('m1', notified)).toBe(true);
  });

  it('tracks meetings independently', () => {
    const notified = new Set<string>();
    expect(shouldNotifyGate('m1', notified)).toBe(true);
    expect(shouldNotifyGate('m2', notified)).toBe(true);
    expect(shouldNotifyGate('m1', notified)).toBe(false);
    expect(shouldNotifyGate('m2', notified)).toBe(false);
  });

  it('clearing an id that was never notified is a harmless no-op', () => {
    const notified = new Set<string>();
    expect(() => clearGateNotified('ghost', notified)).not.toThrow();
    expect(shouldNotifyGate('ghost', notified)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run electron/main/pipeline/gate-alert.test.ts`
Expected: FAIL — `gate-alert.js` does not exist.

- [ ] **Step 3: Implement the module**

Create `electron/main/pipeline/gate-alert.ts`:

```ts
// electron/main/pipeline/gate-alert.ts
//
// Pure decision logic for the "awaiting speaker ID" gate alert. Kept free of
// Electron so it can be unit-tested; the actual native Notification call lives
// in index.ts. The `notified` set records which meetings we've already alerted
// for THIS entry into the gate, so we notify once per entry (spec: no nagging)
// and again only after a genuine re-entry (the flag is cleared when the meeting
// is unblocked — see the IPC handlers).

/** True iff we should fire a notification for this meeting entering the gate.
 *  Records the id as a side effect so the next call for the same visit returns
 *  false. */
export function shouldNotifyGate(meetingId: string, notified: Set<string>): boolean {
  if (notified.has(meetingId)) return false;
  notified.add(meetingId);
  return true;
}

/** Forget a meeting's notified state so a later re-entry into the gate alerts
 *  again. Called from the IPC handlers that move a meeting off the gate. */
export function clearGateNotified(meetingId: string, notified: Set<string>): void {
  notified.delete(meetingId);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/main/pipeline/gate-alert.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/gate-alert.ts electron/main/pipeline/gate-alert.test.ts
git commit -m "feat(speaker-gate): pure dedupe for the awaiting-speaker-id alert"
```

---

### Task 2: Fire a gate-entry listener from the pipeline

**Files:**
- Modify: `electron/main/pipeline/pipeline.ts` (add listener type/set/subscribe near lines 36–45 & 121–124; fire in `process()` at lines 199–205)
- Test: `electron/main/pipeline/pipeline.test.ts`

- [ ] **Step 1: Add the failing test**

In `electron/main/pipeline/pipeline.test.ts`, add a `describe` block (or extend the existing one). This test drives a meeting to the gate and asserts the new listener fires once; a `skipSpeakerId` meeting must not fire it. Adapt the `makeDeps`/harness the existing tests already use — the key assertions are the two `expect`s:

```ts
  it('fires onAwaitingSpeakerId exactly once when a meeting parks at the gate', async () => {
    // Meeting that reaches the gate: identifying done, skipSpeakerId false.
    const meeting = { id: 'm1', slug: 'm1', pipelineStage: 'identifying', status: 'processing', skipSpeakerId: false };
    const found: Record<string, typeof meeting> = { m1: { ...meeting } };
    const ctx = makePipelineCtx({
      meetings: {
        findById: (id: string) => found[id] ?? null,
        updateStage: (id: string, st: string) => { found[id]!.pipelineStage = st; },
        updateStatus: (id: string, st: string) => { found[id]!.status = st; },
      },
    });
    const stages = makeStubStages(); // identifying resolves; summarizing/extracting are stubbed
    const pipeline = new Pipeline({ ctx, stages });
    const gateSpy = vi.fn();
    pipeline.onAwaitingSpeakerId(gateSpy);
    await pipeline.run('m1');
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(gateSpy).toHaveBeenCalledWith('m1');
    // Parked at the gate, not run to done.
    expect(found.m1!.status).toBe('awaiting_user');
  });

  it('does NOT fire onAwaitingSpeakerId when skipSpeakerId is set', async () => {
    const found: Record<string, any> = {
      m2: { id: 'm2', slug: 'm2', pipelineStage: 'identifying', status: 'processing', skipSpeakerId: true },
    };
    const ctx = makePipelineCtx({
      meetings: {
        findById: (id: string) => found[id] ?? null,
        updateStage: (id: string, st: string) => { found[id].pipelineStage = st; },
        updateStatus: (id: string, st: string) => { found[id].status = st; },
      },
    });
    const pipeline = new Pipeline({ ctx, stages: makeStubStages() });
    const gateSpy = vi.fn();
    pipeline.onAwaitingSpeakerId(gateSpy);
    await pipeline.run('m2');
    expect(gateSpy).not.toHaveBeenCalled();
  });
```

> If `makePipelineCtx`/`makeStubStages` helpers don't already exist in the test file, add minimal ones: `ctx` needs `meetings`, `logger` (`{ error(){}, info(){} }`), and whatever the existing tests stub; `stages` is a `Record<WorkStage, StageHandler>` of `vi.fn(async () => {})`. The `merging` stub must resolve (it's called on the skip path). Match the shape the existing pipeline tests already build.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run electron/main/pipeline/pipeline.test.ts`
Expected: FAIL — `pipeline.onAwaitingSpeakerId` is not a function.

- [ ] **Step 3: Add the listener type and subscribe method**

In `electron/main/pipeline/pipeline.ts`, after the `MeetingCompleteListener` type (around line 36) add:

```ts
/** Fires the instant a meeting enters the `awaiting_speaker_id` gate — the one
 *  place the pipeline stops and waits on the user. The wiring in index.ts uses
 *  it to raise a native notification. Errors thrown by listeners are isolated
 *  so a bad listener can't wedge the pipeline. */
export type SpeakerGateListener = (meetingId: string) => void;
```

In the class, next to `completeListeners` (around line 45) add:

```ts
  private readonly gateListeners: Set<SpeakerGateListener> = new Set();
```

After `onMeetingComplete` (around line 124) add:

```ts
  /** Subscribe to gate entries. Fires once each time a meeting reaches
   *  `awaiting_speaker_id`. Returns an unsubscribe fn. */
  onAwaitingSpeakerId(cb: SpeakerGateListener): () => void {
    this.gateListeners.add(cb);
    return () => { this.gateListeners.delete(cb); };
  }
```

- [ ] **Step 4: Fire the listeners at the gate transition**

In `process()`, inside `if (s === 'awaiting_speaker_id')`, replace the parked-branch body (currently lines 200–205):

```ts
          const fresh = this.deps.ctx.meetings.findById(meetingId);
          if (!fresh?.skipSpeakerId) {
            this.deps.ctx.meetings.updateStage(meetingId, s);
            this.deps.ctx.meetings.updateStatus(meetingId, 'awaiting_user');
            return; // stop; user action re-enqueues
          }
```

with:

```ts
          const fresh = this.deps.ctx.meetings.findById(meetingId);
          if (!fresh?.skipSpeakerId) {
            this.deps.ctx.meetings.updateStage(meetingId, s);
            this.deps.ctx.meetings.updateStatus(meetingId, 'awaiting_user');
            // Notify subscribers that this meeting is now blocked on the user.
            // Per-listener isolation matches notify()/complete-listener loops:
            // a throwing listener must not stop us returning to park the gate.
            for (const cb of this.gateListeners) {
              try { cb(meetingId); } catch { /* listener errors must not break the pipeline */ }
            }
            return; // stop; user action re-enqueues
          }
```

- [ ] **Step 5: Run to verify the new tests pass**

Run: `npx vitest run electron/main/pipeline/pipeline.test.ts`
Expected: PASS — the gate listener fires once for the non-skip meeting and not at all for the skip meeting; existing pipeline tests still pass (the listener set is empty for them).

- [ ] **Step 6: Commit**

```bash
git add electron/main/pipeline/pipeline.ts electron/main/pipeline/pipeline.test.ts
git commit -m "feat(pipeline): fire onAwaitingSpeakerId when a meeting parks at the gate"
```

---

### Task 3: Wire the native notification + click routing in index.ts

**Files:**
- Modify: `electron/main/index.ts` (share `focusMainWindow`/`emitOpenMeeting`; add the gate subscription + `notifyGate` shell)

> This task is the thin, untested Electron shell (per the spec's testing strategy). No unit test; covered by the manual verification in Task 6.

- [ ] **Step 1: Hoist the window helpers so both the dispatcher and the gate handler share them**

In `electron/main/index.ts`, the `SchemeDispatcher` construction (around lines 418–444) defines `emitOpenMeeting` and `focusMainWindow` inline. Lift both to named `const`s declared just above the dispatcher, then reference them in the dispatcher options:

```ts
  // Shared window helpers — used by both the URL-scheme dispatcher and the
  // speaker-gate notification below. Kept identical so a notification click
  // routes exactly like a meetingnotes://open?id=… deeplink.
  const emitOpenMeeting = (meetingId: string): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('mn:open-meeting', meetingId);
    }
  };
  const focusMainWindow = (): void => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) return;
    const target = wins[0]!;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  };
```

Then in the `new SchemeDispatcher({ ... })` options, replace the two inline arrow definitions with `emitOpenMeeting,` and `focusMainWindow,` (they now reference the shared consts). Leave `notify` as-is.

- [ ] **Step 2: Add the dedupe set and the gate subscription**

Add the import near the other pipeline imports at the top of the file:

```ts
import { shouldNotifyGate, clearGateNotified } from './pipeline/gate-alert.js';
```

Just after the `pipeline` is constructed (around line 265) declare the shared set:

```ts
  // Meetings we've already alerted about entering the speaker-ID gate, so we
  // notify once per entry (spec: no nagging). Cleared when a meeting is
  // unblocked — see the IPC handlers.
  const gateNotified = new Set<string>();
```

After the shared window helpers / dispatcher wiring, subscribe to the gate:

```ts
  // Native nudge when a meeting parks at the speaker-ID gate. The pipeline
  // otherwise sits blocked on the user with no proactive signal if they've
  // navigated away. Clicking the notification raises the window and lands on
  // the meeting via the same route a meetingnotes://open deeplink uses.
  pipeline.onAwaitingSpeakerId((meetingId) => {
    if (!shouldNotifyGate(meetingId, gateNotified)) return;
    const meeting = meetings.findById(meetingId);
    if (!meeting) return; // deleted between transition and callback — nothing to route to
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: 'MeetingNotes',
        body: `"${meeting.title}" needs you to confirm speakers to keep processing.`,
      });
      n.on('click', () => {
        focusMainWindow();
        emitOpenMeeting(meetingId);
      });
      n.show();
    } catch (err) {
      logger.error('speaker-gate:notify-failed', { meetingId, err: String(err) });
    }
  });
```

- [ ] **Step 3: Pass `gateNotified` to the IPC handlers**

The IPC handlers (Task 4) need to clear the flag on unblock. Find where the handlers are registered in `index.ts` (the `registerHandlers`/`registerIpcHandlers` call that receives the `s`/deps object with `meetings`, `pipeline`, etc.) and add `gateNotified` to that dependency object. Example (match the actual call shape):

```ts
    // ...existing deps...
    gateNotified,
```

- [ ] **Step 4: Type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors. (If the handlers deps type is a named interface, Task 4 Step 1 adds the field there; do that first if tsc complains here, then re-run.)

- [ ] **Step 5: Commit**

```bash
git add electron/main/index.ts
git commit -m "feat(speaker-gate): native notification on gate entry, click routes to the meeting"
```

---

### Task 4: Clear the dedupe flag when the gate is unblocked

**Files:**
- Modify: `electron/main/ipc/handlers.ts` (the `gateNotified` dep + clears in `meetingsRerun` L240, `meetingsSetSkipSpeakerId` L269, `meetingsContinueFromSpeakerId` L290)
- Test: `electron/main/ipc/handlers.test.ts`

- [ ] **Step 1: Add `gateNotified` to the handler deps and clear it on the three unblock paths**

Add the import at the top of `electron/main/ipc/handlers.ts`:

```ts
import { clearGateNotified } from '../pipeline/gate-alert.js';
```

Add `gateNotified: Set<string>;` to the handler dependencies type/interface (the shape of `s`). Then, in each unblock handler, clear the flag so a genuine re-entry alerts again.

In `meetingsContinueFromSpeakerId` (currently line 290), after the guard `if (m.pipelineStage !== 'awaiting_speaker_id') return;` (line 296) add:

```ts
    // Leaving the gate — forget the notified flag so a future re-entry alerts.
    clearGateNotified(id, s.gateNotified);
```

In `meetingsSetSkipSpeakerId` (currently line 269), inside the `if (m?.pipelineStage === 'awaiting_speaker_id')` block (after line 277), add the same clear:

```ts
        clearGateNotified(id, s.gateNotified);
```

In `meetingsRerun` (currently line 240), after `s.meetings.updateStage(parsed.id, parsed.fromStage);` (line 251) add:

```ts
    // A re-run may drive the meeting back into the gate — clear so it re-alerts.
    clearGateNotified(parsed.id, s.gateNotified);
```

- [ ] **Step 2: Add the failing test**

In `electron/main/ipc/handlers.test.ts`, add a test that the continue handler clears the flag. Match the existing handler-test harness (which builds `s` and captures registered handlers). The load-bearing assertion:

```ts
  it('clearing the speaker-ID gate flag lets a re-entry notify again', () => {
    const gateNotified = new Set<string>(['m1']); // already notified this visit
    const s = makeHandlerDeps({
      gateNotified,
      meetings: {
        findById: () => ({ id: 'm1', slug: 'm1', pipelineStage: 'awaiting_speaker_id', status: 'awaiting_user' }),
        updateStage: () => {},
        updateStatus: () => {},
      },
      // remergeTranscript reads roster/settings — stub speakers/settings so it no-ops.
    });
    const ipc = captureIpc(s); // registers handlers, returns { invoke(channel, ...args) }
    ipc.invoke(IPC_CHANNELS.meetingsContinueFromSpeakerId, 'm1');
    expect(gateNotified.has('m1')).toBe(false);
  });
```

> Adapt `makeHandlerDeps`/`captureIpc` to whatever the existing `handlers.test.ts` uses to build deps and invoke a channel. If `remergeTranscript` throws in the stubbed environment it is already caught by the handler's try/catch, so the clear still runs (it's placed after the guard, before the try). Add `gateNotified` to the existing deps builder's defaults (`new Set()`).

- [ ] **Step 3: Run to verify fail then pass**

Run: `npx vitest run electron/main/ipc/handlers.test.ts`
Expected: FAIL before Step 1's edits land (or before the deps builder gains `gateNotified`); PASS after.

- [ ] **Step 4: Commit**

```bash
git add electron/main/ipc/handlers.ts electron/main/ipc/handlers.test.ts
git commit -m "feat(speaker-gate): clear the alert dedupe flag when the gate is unblocked"
```

---

### Task 5: Library "needs your input" summary badge

**Files:**
- Modify: `electron/renderer/src/views/LibraryView.tsx` (derive `awaitingCount`, render the badge)
- Test: `electron/renderer/src/views/LibraryView.test.tsx` (create if absent)

- [ ] **Step 1: Add the failing test**

Create/extend `electron/renderer/src/views/LibraryView.test.tsx`. If no Library test exists, mirror an existing renderer component test (e.g. a `*.test.tsx` under `electron/renderer/src`) for the render harness and `api` mock. The load-bearing assertions:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LibraryView } from './LibraryView';

// Minimal props/store stub: seed the meetings store with one awaiting_user
// meeting and one done meeting. (Match how other renderer tests seed
// useMeetingsStore / mock ../ipc/client — see a sibling *.test.tsx.)

describe('LibraryView speaker-gate summary badge', () => {
  it('shows a "needs you to name voices" badge counting awaiting_user meetings', () => {
    seedMeetings([
      { id: 'm1', status: 'awaiting_user', pipelineStage: 'awaiting_speaker_id', title: 'Standup' },
      { id: 'm2', status: 'done', pipelineStage: 'done', title: 'Retro' },
    ]);
    render(<LibraryView {...baseProps} />);
    expect(screen.getByText(/need you to name voices/i)).toBeInTheDocument();
    expect(screen.getByText(/\b1\b/)).toBeInTheDocument();
  });

  it('hides the badge when no meeting is awaiting_user', () => {
    seedMeetings([{ id: 'm2', status: 'done', pipelineStage: 'done', title: 'Retro' }]);
    render(<LibraryView {...baseProps} />);
    expect(screen.queryByText(/need you to name voices/i)).toBeNull();
  });
});
```

> `seedMeetings`/`baseProps` adapt to the actual store seam. If seeding the zustand store is awkward, mock `../ipc/client`'s `api.meetings.list` to resolve the fixtures and `await` the store refresh before asserting — follow the pattern of the nearest existing renderer test.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run electron/renderer/src/views/LibraryView.test.tsx`
Expected: FAIL — no such badge is rendered.

- [ ] **Step 3: Add the derived count and badge**

In `electron/renderer/src/views/LibraryView.tsx`, near the existing `hasMotion` `useMemo` (around line 109), add:

```tsx
  const awaiting = useMemo(
    () => meetings.filter((m) => m.status === 'awaiting_user'),
    [meetings],
  );
```

Render the badge just above the meeting list (inside the returned JSX, before the list container). Use the existing amber `status-warn*` tokens so it matches the row treatment:

```tsx
      {awaiting.length > 0 && (
        <button
          type="button"
          onClick={() => onOpen(awaiting[0]!.id)}
          className="w-full mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-status-warnBg text-status-warnText border border-status-warn/30 text-sm font-medium hover:border-status-warn/60 transition text-left"
        >
          <span className="w-2 h-2 rounded-full bg-status-warn shrink-0" />
          {awaiting.length} meeting{awaiting.length === 1 ? '' : 's'} need you to name voices
          <span className="ml-auto text-xs text-status-warnText/70">Open →</span>
        </button>
      )}
```

> `onOpen` is the same row-open callback LibraryView already threads to `LibraryRow` (it navigates to detail). If the local name differs (e.g. `openMeeting`), use that. If `useMemo` isn't already imported, add it to the `react` import.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run electron/renderer/src/views/LibraryView.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/src/views/LibraryView.tsx electron/renderer/src/views/LibraryView.test.tsx
git commit -m "feat(library): app-wide 'needs you to name voices' summary badge"
```

---

### Task 6: Full suite, type-check, and manual verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check both projects and run the full suite**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 2: Manual verification (native Notification is the untested shell)**

1. Ensure a meeting will hit the gate: `skipSpeakerId` off, unknown voices present.
2. Start processing, then background the app (or switch to another view).
3. When the meeting reaches `awaiting_speaker_id`, confirm **exactly one** native
   macOS notification appears: `"<title>" needs you to confirm speakers…`.
4. Click the notification → the window is raised/focused and the app lands on that
   meeting's detail view.
5. Confirm the speakers and continue; then re-run the meeting so it parks at the gate
   again → a **second** notification fires (genuine re-entry re-alerts).
6. Confirm the Library shows the amber "N meetings need you to name voices" badge
   whenever ≥1 meeting is `awaiting_user`, and clicking it opens the first one.

- [ ] **Step 3: Commit any final tweaks**

```bash
git add -A
git commit -m "chore(speaker-gate): verification pass"
```

---

## Self-Review

**Spec coverage:** §1 pipeline gate listener → Task 2. §2 pure dedupe module → Task 1. §3 native notification shell + click routing → Task 3. §4 clear-on-unblock in the three IPC handlers → Task 4. §5 Library summary badge → Task 5. §6 tests → embedded in Tasks 1, 2, 4, 5; the untested native shell (Task 3) is covered by Task 6's manual verification, as the spec's testing strategy requires. "What does not change" — no task edits the stage machine, the `awaiting_user` status, the per-row `LibraryRow` treatment, the dispatcher's behavior, the roster/confirm flow, or identity suggestion (separate plan). No gaps.

**Placeholder scan:** Every code step shows complete code. Test steps that must adapt to an existing harness (`makeDeps`/`captureIpc`/`seedMeetings`) call that out explicitly with the load-bearing assertions written in full — the shape to match is named, not invented.

**Type consistency:** `SpeakerGateListener = (meetingId: string) => void` mirrors `MeetingCompleteListener`; `onAwaitingSpeakerId` mirrors `onMeetingComplete` (add-to-set, return unsubscribe). `shouldNotifyGate`/`clearGateNotified` keep the same `(meetingId: string, notified: Set<string>)` signature across Tasks 1/3/4. `gateNotified: Set<string>` is one instance created in `index.ts` and threaded to the handler deps — the notify path (Task 3) and clear path (Task 4) share it by reference, which is what makes the dedupe correct. The notification click reuses the already-typed `focusMainWindow()` + `emitOpenMeeting(meetingId)` — no new IPC channel or preload change (`mn:open-meeting` and `api.onOpenMeeting` already exist).

**Ordering note:** Task 1 must land before Tasks 3/4 (they import `gate-alert.js`). Task 3's `gateNotified` threading and Task 4's deps-type field are interdependent — if `tsc` complains in Task 3 Step 4, add the deps field (Task 4 Step 1) first, then re-run. Each task's own tests pass independently once its dependencies are in place.

**Dedupe correctness (the subtle part):** notify-once-per-entry hinges on one shared `Set`. Entering the gate adds the id (suppressing any duplicate transition in the same visit); leaving the gate via any of the three unblock handlers removes it, so the *next* real entry alerts again. The set is process-lifetime in-memory — acceptable because on app restart the meeting is at `awaiting_speaker_id`/`awaiting_user` on disk but the pipeline does not re-enter the gate (it isn't re-enqueued; `recovery.ts` leaves `awaiting_user` meetings untouched), so there's no spurious re-notify on launch. The in-app badge remains the persistent, restart-surviving signal.
