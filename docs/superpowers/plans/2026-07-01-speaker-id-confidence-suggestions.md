# Speaker ID Confidence Suggestions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a speaker is unidentified, show a confidence-ranked "might be X" suggestion chip the user can tap to confirm, instead of only a blank "— pick a known speaker —" dropdown.

**Architecture:** Investigation found the hard part already exists: `identifying.ts` already computes a cosine-similarity match between each detected voice's embedding and every roster entry's stored embedding (`matchSpeakers` in `electron/main/speakers/matcher.ts`), but only *acts* on matches at or above `MATCH_THRESHOLD` (0.75) — anything below that is discarded (`confidence: null`), never reaching the UI. This plan adds a threshold-free ranking function alongside the existing threshold-gated one (auto-linking behavior is completely unchanged), a `RosterService` method that uses it for one specific unidentified speaker, a new IPC round-trip to fetch it on demand, and a small chip UI in the existing `SpeakerEditor` that calls the **existing** `assignExisting()` handler — no new assignment code path.

**Tech Stack:** Electron main process (speaker matching + IPC), React renderer, vitest (main-process only — this repo has no component-testing setup).

---

### Task 1: Threshold-free candidate ranking in the matcher

**Files:**
- Modify: `electron/main/speakers/matcher.ts`
- Test: `electron/main/speakers/matcher.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `electron/main/speakers/matcher.test.ts`:

```ts
import { matchSpeakers, updateRunningAverage, rankCandidates, MATCH_THRESHOLD } from './matcher.js';

describe('rankCandidates', () => {
  const roster = [
    { id: 'spk_a', embedding: [1, 0, 0] },
    { id: 'spk_b', embedding: [0.6, 0.8, 0] },
    { id: 'spk_c', embedding: [0, 1, 0] },
  ];

  it('ranks every roster entry by similarity, best first', () => {
    const out = rankCandidates({ label: 'Speaker 1', embedding: [0.9, 0.1, 0] }, roster);
    expect(out.map((c) => c.id)).toEqual(['spk_a', 'spk_b', 'spk_c']);
  });

  it('includes candidates below MATCH_THRESHOLD, unlike matchSpeakers', () => {
    // spk_b at [0.6, 0.8, 0] is close but not close enough to auto-link
    // against [0.9, 0.1, 0] — matchSpeakers would discard it entirely.
    const detected = { label: 'Speaker 1', embedding: [0.9, 0.1, 0] };
    const auto = matchSpeakers([detected], roster);
    expect(auto[0]!.rosterId).toBe('spk_a'); // only the best match survives, and only if >= threshold
    const ranked = rankCandidates(detected, roster);
    expect(ranked.length).toBe(3); // all three roster entries, regardless of threshold
    expect(ranked.some((c) => c.confidence < MATCH_THRESHOLD)).toBe(true);
  });

  it('respects the topN cap', () => {
    const out = rankCandidates({ label: 'S', embedding: [1, 0, 0] }, roster, 2);
    expect(out).toHaveLength(2);
  });

  it('skips roster entries with mismatched embedding dimensions', () => {
    const out = rankCandidates(
      { label: 'S', embedding: [1, 0, 0] },
      [...roster, { id: 'spk_bad_dim', embedding: [1, 0] }],
    );
    expect(out.some((c) => c.id === 'spk_bad_dim')).toBe(false);
  });

  it('handles an empty roster', () => {
    expect(rankCandidates({ label: 'S', embedding: [1, 0, 0] }, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main/speakers/matcher.test.ts`
Expected: FAIL — `rankCandidates` is not exported from `./matcher.js`.

- [ ] **Step 3: Implement `rankCandidates`**

Add to `electron/main/speakers/matcher.ts` (after the existing `matchSpeakers` function):

```ts
export interface RankedCandidate { id: string; confidence: number; }

/** Rank every roster entry by cosine similarity to a detected speaker's
 *  embedding, with NO threshold gating — unlike matchSpeakers (which only
 *  auto-links when the best match clears MATCH_THRESHOLD), this is meant to
 *  drive a manual "might be X" suggestion UI, where even a below-threshold
 *  guess is more useful than a blank field. matchSpeakers remains the sole
 *  source of truth for auto-linking; this never changes that behavior. */
export function rankCandidates(
  detected: DetectedSpeaker,
  roster: readonly RosterEntry[],
  topN = 3,
): RankedCandidate[] {
  return roster
    .filter((r) => r.embedding.length === detected.embedding.length)
    .map((r) => ({ id: r.id, confidence: cosineSimilarity(detected.embedding, r.embedding) }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, topN);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/main/speakers/matcher.test.ts`
Expected: PASS (all tests, including the 5 new ones).

- [ ] **Step 5: Commit**

```bash
git add electron/main/speakers/matcher.ts electron/main/speakers/matcher.test.ts
git commit -m "feat(speakers): add threshold-free candidate ranking"
```

---

### Task 2: `RosterService.suggestionsFor`

**Files:**
- Modify: `electron/main/speakers/roster-service.ts`
- Test: `electron/main/speakers/roster-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `electron/main/speakers/roster-service.test.ts`:

```ts
it('suggestionsFor ranks roster entries by similarity with display names attached', () => {
  const aliceId = svc.confirmSpeaker({ displayName: 'Alice', embedding: [1, 0, 0] });
  const bobId = svc.confirmSpeaker({ displayName: 'Bob', embedding: [0, 1, 0] });
  const out = svc.suggestionsFor({ label: 'Speaker 1', embedding: [0.9, 0.1, 0] });
  expect(out[0]).toEqual({ id: aliceId, displayName: 'Alice', confidence: expect.any(Number) });
  expect(out[0]!.confidence).toBeGreaterThan(out[1]!.confidence);
  expect(out[1]!.id).toBe(bobId);
});

it('suggestionsFor returns an empty array for an empty roster', () => {
  expect(svc.suggestionsFor({ label: 'Speaker 1', embedding: [1, 0, 0] })).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main/speakers/roster-service.test.ts`
Expected: FAIL — `svc.suggestionsFor is not a function`.

- [ ] **Step 3: Implement `suggestionsFor`**

In `electron/main/speakers/roster-service.ts`, update the import line and add the method:

```ts
import { matchSpeakers, rankCandidates, updateRunningAverage, type DetectedSpeaker, type Match } from './matcher.js';
```

Add after `identifyUnknowns`:

```ts
  /** Ranked "might be X" suggestions for one specific unidentified speaker —
   *  used by the Speakers panel so the user can confirm a guess instead of
   *  typing a name from scratch. Unlike identifyUnknowns, this has no
   *  MATCH_THRESHOLD gate: it's for a human to eyeball, not to auto-link. */
  suggestionsFor(detected: DetectedSpeaker, topN = 3): { id: string; displayName: string; confidence: number }[] {
    const roster = this.repo.list();
    const nameById = new Map(roster.map((r) => [r.id, r.displayName]));
    const candidates = roster
      .map((r) => ({ id: r.id, embedding: this.safeLoad(r.id) }))
      .filter((r): r is { id: string; embedding: number[] } => r.embedding !== null);
    return rankCandidates(detected, candidates, topN).map((c) => ({
      id: c.id,
      displayName: nameById.get(c.id) ?? '(unknown)',
      confidence: c.confidence,
    }));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/main/speakers/roster-service.test.ts`
Expected: PASS (all tests, including the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add electron/main/speakers/roster-service.ts electron/main/speakers/roster-service.test.ts
git commit -m "feat(speakers): add RosterService.suggestionsFor"
```

---

### Task 3: IPC round-trip

**Files:**
- Modify: `electron/main/ipc/contracts.ts:70-75` (add channel)
- Modify: `electron/preload/index.ts:26-32` (add channel) and `electron/preload/index.ts:157-181` (add method)
- Modify: `electron/main/ipc/handlers.ts` (add handler, near the existing `speakersAssign` handler)

- [ ] **Step 1: Add the channel name to both channel registries**

In `electron/main/ipc/contracts.ts`, in the `IPC_CHANNELS` object, after `speakersAssign: 'speakers:assign',` (line 74):

```ts
  speakersAssign: 'speakers:assign',
  speakersSuggestions: 'speakers:suggestions',
  speakersUnlink: 'speakers:unlink',
```

Make the identical addition in `electron/preload/index.ts`'s separate `IPC_CHANNELS` literal (these two are NOT shared via import — preload runs in an isolated context — so both must be updated by hand):

```ts
  speakersAssign: 'speakers:assign',
  speakersSuggestions: 'speakers:suggestions',
  speakersUnlink: 'speakers:unlink',
```

- [ ] **Step 2: Add the preload method**

In `electron/preload/index.ts`, inside the `speakers: { ... }` namespace, after the `assign` method (before `unlink`):

```ts
    assign: (input: {
      meetingId: string;
      localLabel: string;
      mode: 'existing' | 'new';
      rosterId?: string;
      displayName?: string;
    }) => ipcRenderer.invoke(IPC_CHANNELS.speakersAssign, input) as Promise<string>,
    // Ranked "might be X" guesses for one unidentified speaker, computed
    // from the same voice embeddings the auto-matcher uses — just without
    // its MATCH_THRESHOLD gate, since this is for a human to confirm.
    suggestions: (meetingId: string, localLabel: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.speakersSuggestions, meetingId, localLabel) as Promise<
        { id: string; displayName: string; confidence: number }[]
      >,
    unlink: (meetingId: string, localLabel: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.speakersUnlink, meetingId, localLabel),
```

- [ ] **Step 3: Add the main-process handler**

In `electron/main/ipc/handlers.ts`, immediately after the existing `speakersAssign` handler, add:

```ts
  ipc.handle(IPC_CHANNELS.speakersSuggestions, (_e, meetingId: unknown, localLabel: unknown) => {
    if (typeof meetingId !== 'string' || typeof localLabel !== 'string') throw new Error('invalid args');
    const m = s.meetings.findById(meetingId);
    if (!m) throw new Error('meeting not found');
    const folder = meetingFolderPath(s.libraryRoot, m.slug);
    const diarPath = path.join(folder, 'diarization.json');
    if (!fs.existsSync(diarPath)) return [];
    const diar = JSON.parse(fs.readFileSync(diarPath, 'utf8')) as { segments: DiarizationSegment[] };
    const embedding = averageEmbeddingForLabel(diar.segments, localLabel);
    if (!embedding) return [];
    return s.roster.suggestionsFor({ label: localLabel, embedding });
  });
```

This mirrors the existing `speakersAssign` handler's diarization-loading code exactly (same `meetingFolderPath`, `path`, `fs`, `DiarizationSegment`, `averageEmbeddingForLabel` — all already imported in this file for that handler).

- [ ] **Step 4: Type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/contracts.ts electron/preload/index.ts electron/main/ipc/handlers.ts
git commit -m "feat(speakers): add speakers:suggestions IPC endpoint"
```

---

### Task 4: Suggestion chips in the Speakers panel

**Files:**
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx` (the `SpeakerEditor` component, currently ~lines 2042-2201)

- [ ] **Step 1: Add suggestion state and fetch**

In `SpeakerEditor`, alongside the existing `sample`/`loading`/`newName`/`busy`/`error` state declarations, add:

```tsx
  const [suggestions, setSuggestions] = useState<{ id: string; displayName: string; confidence: number }[]>([]);
```

Add a new effect alongside the existing sample-loading effect (kept separate so a suggestions-fetch failure never blocks sample playback or vice versa):

```tsx
  // Ranked "might be X" guesses, fetched alongside the audio sample. Best-
  // effort: if it fails, the panel just falls back to the plain dropdown —
  // this is a convenience, not a required capability.
  useEffect(() => {
    let alive = true;
    api.speakers.suggestions(meetingId, localLabel)
      .then((list) => { if (alive) setSuggestions(list); })
      .catch(() => { /* fall back silently to the manual dropdown */ });
    return () => { alive = false; };
  }, [meetingId, localLabel]);
```

- [ ] **Step 2: Render suggestion chips above the manual dropdown**

Immediately before the existing "Assign to existing roster entry" block (the `{assignableRoster.length > 0 && (...)}` block), add:

```tsx
      {/* Confidence-ranked guesses computed from the same voice-embedding
          match the auto-linker uses — tap one to confirm instead of typing
          a name from scratch. Excludes whichever entry is already linked. */}
      {suggestions.filter((sug) => sug.id !== rosterId).length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-ink-muted uppercase mb-1">Might be</div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.filter((sug) => sug.id !== rosterId).map((sug) => (
              <button
                key={sug.id}
                disabled={busy}
                onClick={() => void assignExisting(sug.id)}
                className="text-[11px] font-medium px-2 py-1 rounded-full bg-brand-indigo/10 text-brand-indigo
                           hover:bg-brand-indigo/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {sug.displayName} ({Math.round(sug.confidence * 100)}%)
              </button>
            ))}
          </div>
        </div>
      )}
```

This calls the **existing** `assignExisting()` function already defined in `SpeakerEditor` — no new assignment logic.

- [ ] **Step 3: Verify manually in the running app**

Run: `npm run dev`
- Open a meeting with at least one named roster speaker and one unidentified `SPEAKER_XX` row.
- Expand the unidentified row: confirm a "Might be" chip row appears above "Assign to" (or doesn't, if no roster entries are close enough in embedding space — that's expected when the roster is empty or very different).
- Click a suggestion chip: confirm it assigns the speaker exactly as the existing dropdown would (same visual "named" state afterward).

- [ ] **Step 4: Type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/src/views/MeetingDetailView.tsx
git commit -m "feat(speakers): show confidence-ranked suggestions in the Speakers panel"
```

---

## Self-Review

**Spec coverage:** Idea #8 — "speaker ID confidence suggestions, reusing existing roster/voiceprint matching" — fully covered. All four tasks build directly on infrastructure investigation confirmed already exists (`cosineSimilarity`, roster embeddings, `matchSpeakers`), adding only what was genuinely missing: a threshold-free ranking view of that same data and a way to surface it.

**Placeholder scan:** No TBD/TODO; every step has complete code.

**Type consistency:** `RankedCandidate` (`{ id: string; confidence: number }`) from Task 1 is the return type `rankCandidates` produces; Task 2's `suggestionsFor` maps it 1:1 into `{ id, displayName, confidence }`, which Task 3's handler returns verbatim and Task 3's preload types as `Promise<{ id: string; displayName: string; confidence: number }[]>` — Task 4's renderer state (`useState<{ id: string; displayName: string; confidence: number }[]>`) matches exactly. No drift across the four layers.

**Reuse check:** Task 4 calls the pre-existing `assignExisting(rosterId: string)` function (unchanged) rather than introducing a second assignment path — confirmed against the current `SpeakerEditor` source before writing this plan.
