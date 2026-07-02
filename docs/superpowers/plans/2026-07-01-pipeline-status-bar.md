# App-wide Pipeline Status Bar + Rough Early Estimates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a slim app-wide bottom status bar showing the in-flight pipeline run from any view, and let the learned per-stage ETA show a hedged "rough" estimate after a single sample instead of "estimating…" for the first three.

**Architecture:** Six additive changes per `docs/superpowers/specs/2026-07-01-pipeline-status-bar-design.md`: (1) `estimateStage` returns `{etaMs, rough}`; (2) the composer propagates roughness through the parallel max; (3) an additive `stageEtaRough` boolean on the IPC payload; (4) `fmtEta` gains a `rough` param; (5) a new pure `status-bar` derivation module; (6) a thin `PipelineStatusBar` component wired into the App shell + store. Pure logic is TDD'd; React shells are type-checked + manually verified (no DOM harness in this repo).

**Tech Stack:** TypeScript (Electron main + React renderer), vitest.

---

### Task 1: `estimateStage` — median + roughness grade

**Files:**
- Modify: `electron/main/lib/stage-eta.ts`
- Test: `electron/main/lib/stage-eta.test.ts`

- [ ] **Step 1:** Replace the `describe('estimateMs', …)` block with a `describe('estimateStage', …)` block: `[]` → null; `[100]` → `{etaMs:100, rough:true}`; `[100,200]` → `{etaMs:150, rough:true}`; `[300,100,200]` → `{etaMs:200, rough:false}`; `[100,200,300,400]` → `{etaMs:250, rough:false}`; outlier `[100,110,120,130,600000]` → `{etaMs:120, rough:false}`; non-mutation. Update the import to `estimateStage`.
- [ ] **Step 2:** `npx vitest run electron/main/lib/stage-eta.test.ts` → FAIL (no `estimateStage`).
- [ ] **Step 3:** Add `export interface StageEstimate { etaMs: number; rough: boolean }`. Replace `estimateMs` with `estimateStage(samples): StageEstimate | null`: `[]` → null; else median (existing logic) with `rough: samples.length < MIN_SAMPLES`. Update the `MIN_SAMPLES` doc comment to "minimum for a firm estimate".
- [ ] **Step 4:** `npx vitest run electron/main/lib/stage-eta.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(eta): estimateStage returns a rough flag for 1-2 sample cold starts`.

---

### Task 2: composer propagates roughness through the parallel max

**Files:**
- Modify: `electron/main/ipc/stage-eta-for-meeting.ts`
- Test: `electron/main/ipc/stage-eta-for-meeting.test.ts`

- [ ] **Step 1:** Update the test: return type is now `StageEstimate | null`. Cold start → null; warm single stage `[1000,3000,2000]` → `{etaMs:2000, rough:false}`; two-sample `summarizing:1=[1000,2000]` → `{etaMs:1500, rough:true}`; parallel firm+firm (transcribing `[1000×3]`, diarizing `[4000×3]`) → `{etaMs:4000, rough:false}`; parallel where the SLOWER branch (diarizing `[4000×3]` firm) wins but faster branch (transcribing `[1000,1000]` rough) is rough → still `{etaMs:4000, rough:true}`; warm+cold sibling (`transcribing:[2000×3]`, `diarizing:[]`) → `{etaMs:2000, rough:false}` (null sibling ignored).
- [ ] **Step 2:** `npx vitest run electron/main/ipc/stage-eta-for-meeting.test.ts` → FAIL.
- [ ] **Step 3:** Rewrite using `estimateStage`. `estimateForStage` returns `StageEstimate | null`. Single stage: return it directly. Parallel: collect non-null branches; if none → null; `etaMs = max(branches.etaMs)`; `rough = branches.some(b => b.rough)`.
- [ ] **Step 4:** `npx vitest run electron/main/ipc/stage-eta-for-meeting.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(eta): propagate rough flag through the parallel transcribe max`.

---

### Task 3: additive `stageEtaRough` on the IPC payload

**Files:**
- Modify: `electron/main/ipc/contracts.ts` (schema), `electron/main/ipc/handlers.ts` (both handlers)

- [ ] **Step 1:** In `contracts.ts` `MeetingSummarySchema`, after `stageEtaMs: z.number().nullable(),` add `stageEtaRough: z.boolean(),` with a one-line doc comment. (Detail schema extends summary — inherited.)
- [ ] **Step 2:** In `handlers.ts` `meetings:list` and `meetings:get`, the composer now returns `StageEstimate | null`. Capture into `const eta = stageEtaForMeeting(...)` and emit `stageEtaMs: eta?.etaMs ?? null, stageEtaRough: eta?.rough ?? false`.
- [ ] **Step 3:** `npx tsc -p tsconfig.node.json --noEmit` → clean. Run `npx vitest run electron/main/ipc/handlers.test.ts` → PASS (contracts-parity + handler registration unaffected).
- [ ] **Step 4:** Commit `feat(ipc): expose stageEtaRough on meeting summary/detail payloads`.

---

### Task 4: `fmtEta(etaMs, rough)`

**Files:**
- Modify: `electron/renderer/src/lib/fmtEta.ts`, `electron/renderer/src/lib/fmtEta.test.ts`

- [ ] **Step 1:** Add tests: `fmtEta(180_000, true)` → `~3m (rough)`; `fmtEta(45_000, true)` → `~45s (rough)`; `fmtEta(180_000, false)` → `~3m` (existing); `fmtEta(null, true)` → `estimating…` (rough ignored when null). Existing cases unchanged.
- [ ] **Step 2:** `npx vitest run electron/renderer/src/lib/fmtEta.test.ts` → FAIL.
- [ ] **Step 3:** `fmtEta(etaMs: number | null, rough = false)`: null → `estimating…`; else build `~Ns`/`~Nm` then append ` (rough)` when `rough`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(eta): fmtEta hedges a rough estimate with a (rough) suffix`.

---

### Task 5: pure status-bar derivation module

**Files:**
- Create: `electron/renderer/src/lib/status-bar.ts`, `electron/renderer/src/lib/status-bar.test.ts`

- [ ] **Step 1:** Write `status-bar.test.ts` covering: hidden (`null`) when no `currentId` and empty queue (paused or not); `deriveStatusBar` maps `currentId` → model with title from summaries (fallback `"…"`), stage label via `stepIndexFor`/`USER_STEPS` (transcribe→Transcribing, name voices→Identifying speakers, summarize→Summarizing, extract→Extracting, unknown→Processing), `etaMs`/`etaRough`/`stageStartedAt`/`queued`; `statusBarText` exact strings: `Summarizing "Q3 sync" — 17s · ~3m · 2 queued`, elapsed dropped when null, `(rough)` hedge, `estimating…` fallback, queue suffix only when >0, `Paused — finishing "Q3 sync" · 2 queued`, `Paused — 2 queued`, `2 queued`.
- [ ] **Step 2:** `npx vitest run electron/renderer/src/lib/status-bar.test.ts` → FAIL.
- [ ] **Step 3:** Implement `StatusBarModel`, `deriveStatusBar(meetings, pipelineStatus)`, `statusBarText(model, elapsedSeconds)` per the spec. Reuse `fmtEta` for the ETA segment and `fmtElapsed` for elapsed.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(status-bar): pure derivation of the app-wide pipeline status line`.

---

### Task 6: `PipelineStatusBar` component + App shell + store

**Files:**
- Create: `electron/renderer/src/components/PipelineStatusBar.tsx`
- Modify: `electron/renderer/src/store/meetings.ts` (add `stageEtaMs`/`stageEtaRough` to `MeetingSummary` + `shallowEqual`), `electron/renderer/src/App.tsx` (render below the body slot), `electron/renderer/src/views/MeetingDetailView.tsx` (pass `meeting.stageEtaRough` into the two `fmtEta` calls; add `stageEtaRough` to its local type)

- [ ] **Step 1:** Store: add `stageEtaMs: number | null` and `stageEtaRough: boolean` to `MeetingSummary`; add `stageEtaMs` (and `stageEtaRough`) to `shallowEqual`.
- [ ] **Step 2:** `PipelineStatusBar.tsx`: `useMeetingsStore` for summaries; own `pipeline.status()` pull + `onStatusChange` subscription; a 3s `refresh()` interval gated on `model && model.kind==='processing'`; `useElapsed(model.stageStartedAt, kind==='processing')`; render `null` when `deriveStatusBar` returns null; otherwise a `shrink-0` bottom strip showing `statusBarText`, clickable → `onOpenMeeting(model.meetingId)`.
- [ ] **Step 3:** App.tsx: render `{onboardStatus === 'done' && <PipelineStatusBar onOpenMeeting={(id) => setView({ kind: 'detail', id })} />}` as a `shrink-0` sibling after the `flex-1 min-h-0` body div.
- [ ] **Step 4:** MeetingDetailView: local type gains `stageEtaRough: boolean`; the two `fmtEta(meeting.stageEtaMs)` calls become `fmtEta(meeting.stageEtaMs, meeting.stageEtaRough)`.
- [ ] **Step 5:** `npx tsc -p tsconfig.json --noEmit` → clean. `npx vitest run` → all green.
- [ ] **Step 6:** Commit `feat(status-bar): app-wide bottom pipeline status bar wired into the shell`.
- [ ] **Step 7:** Manual verification (not runnable here): process a meeting, confirm the bar shows from Settings/Weekly, click routes to the meeting, hides when idle. Note as not-run.

---

## Self-Review

**Spec coverage:** §A status bar → Tasks 5–6; §B rough estimate → Tasks 1–4. Every "Changes" subsection maps to a task. **Placeholder scan:** each step has an assertion + command. **Type consistency:** `StageEstimate {etaMs, rough}` defined in Task 1, consumed by Tasks 2–3; `stageEtaRough` boolean flows contracts → handlers → store → component/detail identically; `fmtEta(etaMs, rough)` signature used consistently in Tasks 4/6.
