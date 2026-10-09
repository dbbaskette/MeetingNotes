# Unify Failure Retry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the failed-stage banner's "Retry ↻" button use the same underlying re-run primitive as the left rail's "Re-run pipeline from…" buttons, instead of a separate, less-safe code path — so there's one consistent retry mental model instead of two.

**Architecture:** Investigation found `FailureBanner`'s Retry button calls `api.meetings.start(id)`, which just flips status to `processing` and re-enqueues the meeting from wherever `pipelineStage` currently sits — it does **not** clear any artifacts, stale action items, or speaker links left behind by the failed attempt. The left rail's re-run buttons call `api.meetings.rerun(id, fromStage)`, which does all of that clearing before re-enqueuing. Since `meeting.pipelineStage` at the moment of failure already holds the exact stage that failed (the pipeline handler throws before advancing it), and `rerun`'s stage validation (`isStage`) accepts any of the six real pipeline stages — not just the three the rail happens to expose as buttons — Retry can call `rerun(id, meeting.pipelineStage)` directly. This is a strict safety improvement with no behavior change visible to the user beyond "retry now cleans up after itself."

**Tech Stack:** React renderer (Electron). No backend changes — `meetings:rerun`'s handler and its artifact-clearing logic (`clearArtifactsFromStage`, `shouldClearActionItems`, `shouldClearSpeakerLinks`) are unchanged; this plan is a call-site swap in the renderer only.

**Non-goal:** Changing the left rail's UI, the speaker-ID gate's "Continue" button (`continueFromSpeakerId`), or unifying their visual presentation. The gate's Continue is a different action entirely (resuming past a wait-state the pipeline paused at on purpose, not recovering from a failure) and conflating it here would misapply "retry" to something that isn't one.

---

### Task 1: Retry the failed stage via `rerun`, not `start`

**Files:**
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx:479-489` (the `FailureBanner`'s `retry()` function)

- [ ] **Step 1: Confirm current behavior**

The existing `retry()` function (`electron/renderer/src/views/MeetingDetailView.tsx:479-489`):

```tsx
  async function retry(): Promise<void> {
    if (retrying) return;
    setRetrying(true);
    try {
      await api.meetings.start(meeting.id);
      await onReload(); // bumps the poll loop; status flips to 'processing'
    } finally {
      setRetrying(false);
    }
  }
```

- [ ] **Step 2: Swap to `rerun`, targeting the failed stage**

Replace it with:

```tsx
  async function retry(): Promise<void> {
    if (retrying) return;
    setRetrying(true);
    try {
      // Retry the exact stage that failed via the same primitive the left
      // rail's "Re-run pipeline from…" buttons use — meeting.pipelineStage
      // still holds the failed stage (the pipeline never advances it past a
      // throw), and unlike api.meetings.start(), rerun() clears any stale
      // artifacts/action-items/speaker-links left behind by the failed
      // attempt before re-enqueuing.
      await api.meetings.rerun(meeting.id, meeting.pipelineStage);
      await onReload(); // bumps the poll loop; status flips to 'processing'
    } finally {
      setRetrying(false);
    }
  }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors — `api.meetings.rerun(id: string, fromStage: string)` accepts `meeting.pipelineStage` (typed `string` on `MeetingDetail`) with no cast needed.

- [ ] **Step 4: Verify manually in the running app**

Run: `npm run dev`
- Force a failure (e.g. stop LM Studio mid-extract, or use a meeting that's already in a `failed` state from earlier testing).
- Click "Retry ↻" on the failure banner.
- Confirm the meeting re-enters `processing` at the same stage it failed on (not restarted from `transcribing`), and that the stage completes normally on retry once the underlying issue (e.g. LM Studio) is fixed.
- Confirm `action-items.json` / DB action items reflect only the successful retry's output — no duplicates or stale entries from the failed attempt.

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/src/views/MeetingDetailView.tsx
git commit -m "fix(pipeline): retry the failed stage via rerun(), not start()"
```

---

## Self-Review

**Spec coverage:** Idea #4 — "unify Retry with Re-run pipeline from…" — is covered via the safer, more precise fix that investigation actually surfaced: both actions now share one primitive (`meetings:rerun`), eliminating the inconsistency at the root instead of just relabeling a button.

**Note on idea #3 (elapsed time per pipeline stage):** Investigation found this is **already implemented** — `StageTimeline` (`MeetingDetailView.tsx:520-578`) already renders elapsed time via `useElapsed(meeting.stageStartedAt, ...)` and `fmtElapsed()` next to the currently-processing step pill. It wasn't visible in the screenshot that prompted the idea only because that screenshot showed a *failed* meeting, not one mid-stage. No plan needed for this half of the original idea.

**Placeholder scan:** No TBD/TODO; complete code.

**Type consistency:** `api.meetings.rerun(id: string, fromStage: string)` (per `electron/preload/index.ts`) is called with `meeting.pipelineStage`, which is typed `string` on the renderer's local `MeetingDetail` interface (`MeetingDetailView.tsx:24-50`) — matches without a cast.
