# Action-Item Provenance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each action item clickable so the user can see WHERE it came from — clicking "Show source" switches to the Summary tab and highlights the `## Action Items` bullet the item was extracted from. Provenance is established by a pure, LLM-free fuzzy match of each item's text against the summary bullets (approach (b) in `docs/superpowers/specs/2026-07-01-action-item-provenance-design.md`), so no model or prompt changes are needed.

**Architecture:** Six small changes per the approved spec: (1) add a nullable `source_quote` column via migration 12, (2) persist it through `ActionItemsRepo`, (3) a pure matcher module `action-item-source.ts` that scores item text against summary bullets, (4) wire the matcher into the extract stage (it already has the parsed items and the summary in memory), (5) surface `sourceQuote` over the `meetings:get` IPC, (6) renderer "Show source" affordance that jumps to and highlights the summary bullet, reusing the existing tab-switch + scrollIntoView pattern.

**Tech Stack:** TypeScript (Electron main + preload), React (renderer), better-sqlite3, vitest.

---

### Task 1: Add the `source_quote` column (migration 12)

**Files:**
- Modify: `electron/main/storage/migrations.ts` (append to `MIGRATIONS`, currently ends at version 11, line ~219)
- Test: `electron/main/storage/db.test.ts`

- [ ] **Step 1: Add the failing test**

In `electron/main/storage/db.test.ts`, add inside `describe('openDb', ...)`:

```ts
  it('adds the action_items.source_quote column', () => {
    const dir = tmp(); dirs.push(dir);
    const db = openDb(path.join(dir, 'db.sqlite'));
    const cols = db.prepare("PRAGMA table_info(action_items)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('source_quote');
  });
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npx vitest run electron/main/storage/db.test.ts`
Expected: FAIL — `action_items` has no `source_quote` column yet.

- [ ] **Step 3: Append the migration**

In `electron/main/storage/migrations.ts`, add a new entry to the `MIGRATIONS` array immediately after the version 11 object (before the closing `];`):

```ts
  {
    version: 12,
    // Action-item provenance (#provenance). Each extracted action item is a
    // reworded version of one "## Action Items" bullet in summary.md. Store
    // the verbatim source bullet so the UI can jump from an item to the
    // summary text it came from. Nullable with no default: existing rows and
    // hand-added items (which have no source) read back NULL, exactly the
    // "unknown provenance" state the UI already handles. Populated only by
    // the extract stage's post-hoc fuzzy matcher — no LLM/schema change.
    up: `
      ALTER TABLE action_items ADD COLUMN source_quote TEXT;
    `,
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/main/storage/db.test.ts`
Expected: PASS (including the existing "expected tables" and idempotency tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/storage/migrations.ts electron/main/storage/db.test.ts
git commit -m "feat(db): add action_items.source_quote column (migration 12)"
```

---

### Task 2: Persist `source_quote` through `ActionItemsRepo`

**Files:**
- Modify: `electron/main/storage/action-items-repo.ts`
- Test: `electron/main/storage/action-items-repo.test.ts`

- [ ] **Step 1: Add the failing tests**

In `electron/main/storage/action-items-repo.test.ts`, add inside `describe('ActionItemsRepo', ...)`:

```ts
  it('round-trips source_quote through replaceForMeeting + listByMeeting', () => {
    repo.replaceForMeeting(meetingId, [
      { text: 'Ship v2', owner: 'Dan', due_date: null, sourceQuote: '- Ship the v2 API — Dan' },
      { text: 'No source', owner: null, due_date: null },
    ]);
    const all = repo.listByMeeting(meetingId);
    expect(all[0]!.sourceQuote).toBe('- Ship the v2 API — Dan');
    // An item with no sourceQuote (hand-added shape) reads back null.
    expect(all[1]!.sourceQuote).toBeNull();
  });

  it('create() leaves source_quote null', () => {
    const created = repo.create(meetingId, { text: 'hand-added' });
    expect(created.sourceQuote).toBeNull();
    expect(repo.listByMeeting(meetingId)[0]!.sourceQuote).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/main/storage/action-items-repo.test.ts`
Expected: FAIL — `ActionItemRow` has no `sourceQuote`; `replaceForMeeting` doesn't accept or persist it.

- [ ] **Step 3: Add `sourceQuote` to the row type, mapper, and insert**

In `electron/main/storage/action-items-repo.ts`:

Replace the import line (currently line 3):

```ts
import type { ActionItem } from '../lib/action-item-schema.js';
```

with:

```ts
import type { ActionItem } from '../lib/action-item-schema.js';

/** An action item as produced by the extract stage after provenance
 *  matching: the model's { text, owner, due_date } plus the verbatim
 *  summary bullet it was matched to (null when nothing matched). */
export type ActionItemWithSource = ActionItem & { sourceQuote?: string | null };
```

Add `sourceQuote` to the `ActionItemRow` interface (currently lines 5–10) — insert after the `dueDate` field:

```ts
  dueDate: string | null;
  sourceQuote: string | null;
```

In `row()` (currently lines 12–24), add the mapping after `dueDate`:

```ts
    dueDate: (r.due_date as string) ?? null,
    sourceQuote: (r.source_quote as string) ?? null,
```

Change `replaceForMeeting` (currently lines 29–41) to accept the enriched type and insert the column:

```ts
  replaceForMeeting(meetingId: string, items: readonly ActionItemWithSource[]): void {
    const del = this.db.prepare('DELETE FROM action_items WHERE meeting_id = ?');
    const ins = this.db.prepare(`
      INSERT INTO action_items (id, meeting_id, text, owner_speaker_id, due_date, source_quote, status, exported_to, created_at)
      VALUES (?, ?, ?, NULL, ?, ?, 'open', '[]', ?)
    `);
    const tx = this.db.transaction(() => {
      del.run(meetingId);
      const now = new Date().toISOString();
      for (const it of items) ins.run(`ai_${shortId()}`, meetingId, it.text, it.due_date, it.sourceQuote ?? null, now);
    });
    tx();
  }
```

(`create()` doesn't touch `source_quote`, so its insert omits the column and SQLite stores `NULL` — the test in Step 1 confirms this.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/main/storage/action-items-repo.test.ts`
Expected: PASS (all tests, including the pre-existing replace/setStatus/markExported cases — their item literals have no `sourceQuote`, which is now optional).

- [ ] **Step 5: Commit**

```bash
git add electron/main/storage/action-items-repo.ts electron/main/storage/action-items-repo.test.ts
git commit -m "feat(storage): persist source_quote on action items"
```

---

### Task 3: Pure fuzzy matcher `action-item-source.ts`

**Files:**
- Create: `electron/main/lib/action-item-source.ts`
- Test: `electron/main/lib/action-item-source.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `electron/main/lib/action-item-source.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matchSourceQuotes } from './action-item-source.js';
import type { ActionItem } from './action-item-schema.js';

const item = (text: string): ActionItem => ({ text, owner: null, due_date: null });

const SUMMARY = `## Overview
Weekly sync.

## Action Items
- Ship the v2 API by Friday — Dan — 2026-07-03
- Write the migration guide — Priya — (no date)

## Follow-ups
- Nothing pending.`;

describe('matchSourceQuotes', () => {
  it('matches a reworded item to its verbatim summary bullet', () => {
    const [r] = matchSourceQuotes([item('Ship v2 API')], SUMMARY);
    expect(r!.sourceQuote).toBe('Ship the v2 API by Friday — Dan — 2026-07-03');
  });

  it('matches each item to its own bullet', () => {
    const res = matchSourceQuotes(
      [item('Write migration guide'), item('Ship the v2 API')],
      SUMMARY,
    );
    expect(res[0]!.sourceQuote).toContain('migration guide');
    expect(res[1]!.sourceQuote).toContain('v2 API');
  });

  it('returns null when nothing clears the threshold', () => {
    const [r] = matchSourceQuotes([item('Book the offsite venue in Lisbon')], SUMMARY);
    expect(r!.sourceQuote).toBeNull();
  });

  it('falls back to all bullets when there is no Action Items section', () => {
    const noSection = `## Overview\nStuff.\n\n## Decisions\n- Adopt Postgres for the new service.`;
    const [r] = matchSourceQuotes([item('Adopt Postgres for the service')], noSection);
    expect(r!.sourceQuote).toBe('Adopt Postgres for the new service.');
  });

  it('returns null for every item on an empty summary', () => {
    const res = matchSourceQuotes([item('anything'), item('else')], '');
    expect(res.every((r) => r.sourceQuote === null)).toBe(true);
  });

  it('preserves the original item fields', () => {
    const [r] = matchSourceQuotes(
      [{ text: 'Ship v2 API', owner: 'Dan', due_date: '2026-07-03' }],
      SUMMARY,
    );
    expect(r!.owner).toBe('Dan');
    expect(r!.due_date).toBe('2026-07-03');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/main/lib/action-item-source.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement the matcher**

Create `electron/main/lib/action-item-source.ts`:

```ts
// electron/main/lib/action-item-source.ts
//
// Provenance matching (#provenance). The extract stage turns each
// "## Action Items" bullet in summary.md into an action item, rewording it
// (dropping the marker, sometimes trimming the owner/date). This module runs
// the inverse: given the parsed items and the summary they came from, find the
// verbatim source bullet for each so the UI can jump item -> summary bullet.
//
// Pure and LLM-free — a token-overlap score against the small set of summary
// bullets (typically 5–30 short lines). No model change, fully unit-testable.
// When no bullet is a confident match, sourceQuote is null and the UI simply
// won't offer a "Show source" jump for that item.

import type { ActionItem } from './action-item-schema.js';

export type ActionItemWithSource = ActionItem & { sourceQuote: string | null };

/** Below this normalized token-overlap (Jaccard) score we treat a bullet as
 *  "not really the source" and return null rather than risk a wrong jump. */
const MATCH_THRESHOLD = 0.5;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'by', 'with',
  'is', 'are', 'be', 'will', 'should', 'no', 'date', 'tbd', 'owner',
]);

/** Lowercase, strip punctuation, split on whitespace, drop stopwords. */
function tokenize(s: string): Set<string> {
  const toks = s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  return new Set(toks);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Strip a leading list marker ("- " / "* ") and an optional leading bold
 *  label ("**Foo:** rest") so the returned quote is the human-readable bullet
 *  text — but keep the ORIGINAL casing/punctuation for display + DOM matching. */
function cleanBullet(line: string): string {
  return line.replace(/^\s*[-*]\s+/, '').trim();
}

/** Pull the bullets to search. Prefer the "## Action Items" section; if there
 *  is none, fall back to every "-"/"*" bullet in the summary (extract also
 *  pulls commitments from Decisions/Follow-ups). */
function candidateBullets(summaryMd: string): string[] {
  const lines = summaryMd.split('\n');
  const headingIdx = lines.findIndex((l) => /^##\s+action items\s*$/i.test(l.trim()));
  let scope = lines;
  if (headingIdx !== -1) {
    let end = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i]!.trim())) { end = i; break; }
    }
    scope = lines.slice(headingIdx + 1, end);
  }
  return scope
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map(cleanBullet)
    .filter((b) => b.length > 0);
}

export function matchSourceQuotes(
  items: readonly ActionItem[],
  summaryMd: string,
): ActionItemWithSource[] {
  const bullets = candidateBullets(summaryMd);
  const bulletTokens = bullets.map((b) => ({ text: b, tokens: tokenize(b) }));
  return items.map((it) => {
    const itemTokens = tokenize(it.text);
    let best: { text: string; score: number } | null = null;
    for (const b of bulletTokens) {
      const score = jaccard(itemTokens, b.tokens);
      if (!best || score > best.score) best = { text: b.text, score };
    }
    return {
      ...it,
      sourceQuote: best && best.score >= MATCH_THRESHOLD ? best.text : null,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/main/lib/action-item-source.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/lib/action-item-source.ts electron/main/lib/action-item-source.test.ts
git commit -m "feat(extract): fuzzy-match action items to their summary bullet"
```

---

### Task 4: Wire the matcher into the extract stage

**Files:**
- Modify: `electron/main/pipeline/stages/extracting.ts`
- Test: `electron/main/pipeline/stages/extracting.test.ts`

- [ ] **Step 1: Add the failing test**

In `electron/main/pipeline/stages/extracting.test.ts`, add inside `describe('runExtracting', ...)`. (This assumes the summary-based test helper from the `2026-07-01-extract-from-summary` plan — `makeCtx` writing `summary.md` and a `chat` mock. If your local helper differs, adapt the fixture wiring, not the assertions.)

```ts
  it('attaches source_quote by matching items to the summary bullets', async () => {
    const summary =
      '## Action Items\n' +
      '- Ship the v2 API by Friday — Dan — 2026-07-03\n' +
      '- Buy more coffee — (owner TBD) — (no date)';
    const { ctx, folder } = makeCtx(
      // Model returns a reworded item plus one that matches nothing in the summary.
      async () =>
        '[{"text":"Ship v2 API","owner":"Dan","due_date":"2026-07-03"},' +
        '{"text":"Rewrite the auth service from scratch","owner":null,"due_date":null}]',
    );
    fs.writeFileSync(path.join(folder, 'summary.md'), summary);
    await runExtracting({ meetingId: 'm' }, ctx);

    const persisted = ctx.actionItems.replaceForMeeting.mock.calls[0]![1] as {
      text: string; sourceQuote: string | null;
    }[];
    expect(persisted[0]!.sourceQuote).toBe('Ship the v2 API by Friday — Dan — 2026-07-03');
    expect(persisted[1]!.sourceQuote).toBeNull();

    // action-items.json carries the same enriched shape.
    const written = JSON.parse(fs.readFileSync(path.join(folder, 'action-items.json'), 'utf8'));
    expect(written[0].sourceQuote).toContain('v2 API');
  });
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npx vitest run electron/main/pipeline/stages/extracting.test.ts`
Expected: FAIL — the stage passes bare `{ text, owner, due_date }` items, so `sourceQuote` is `undefined`, not the matched bullet / `null`.

- [ ] **Step 3: Wire the matcher in**

In `electron/main/pipeline/stages/extracting.ts`, add the import after the existing `parseActionItemsLoose` import (line 7):

```ts
import { matchSourceQuotes } from '../../lib/action-item-source.js';
```

Then replace the block that parses and persists (currently lines 46–48):

```ts
  const items = parseActionItemsLoose(raw);
  fs.writeFileSync(path.join(folder, 'action-items.json'), JSON.stringify(items, null, 2));
  ctx.actionItems.replaceForMeeting(meetingId, items);
```

with:

```ts
  // Attach provenance: match each extracted item back to the verbatim
  // "## Action Items" bullet it was reworded from, so the UI can jump from an
  // item to its summary source. Pure/LLM-free; unmatched items get null and
  // simply show no "Show source" affordance. The summary is already in memory.
  const items = matchSourceQuotes(parseActionItemsLoose(raw), summary);
  fs.writeFileSync(path.join(folder, 'action-items.json'), JSON.stringify(items, null, 2));
  ctx.actionItems.replaceForMeeting(meetingId, items);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/main/pipeline/stages/extracting.test.ts`
Expected: PASS (all cases — the new one plus the pre-existing summary-input cases, which don't assert on `sourceQuote`).

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/stages/extracting.ts electron/main/pipeline/stages/extracting.test.ts
git commit -m "feat(extract): attach source_quote provenance to extracted items"
```

---

### Task 5: Surface `sourceQuote` over the `meetings:get` IPC

**Files:**
- Modify: `electron/main/ipc/handlers.ts` (the `meetingsGet` handler's `actionItems.map`, currently lines 200–204)
- Test: `electron/main/ipc/handlers.test.ts`

- [ ] **Step 1: Add the failing test**

In `electron/main/ipc/handlers.test.ts`, add a case to the block that exercises `meetings:get` (search for the existing `meetingsGet` / `meetings:get` test and mirror its setup). The assertion:

```ts
  it('includes source_quote on each action item from meetings:get', async () => {
    // (reuse the file's existing meeting-with-action-items fixture setup)
    ctx.actionItems.replaceForMeeting(meetingId, [
      { text: 'Ship v2', owner: null, due_date: null, sourceQuote: '- Ship the v2 API' },
    ]);
    const detail = (await invoke('meetings:get', meetingId)) as {
      actionItems: { text: string; sourceQuote: string | null }[];
    };
    expect(detail.actionItems[0]!.sourceQuote).toBe('- Ship the v2 API');
  });
```

(If `handlers.test.ts` has no existing `meetings:get` fixture to reuse, and wiring one up is heavy, treat this assertion as covered by Task 2's repo round-trip test + the manual verification step, and skip Step 1–2 here — the handler change in Step 3 is a one-line field passthrough.)

- [ ] **Step 2: Run tests to verify it fails**

Run: `npx vitest run electron/main/ipc/handlers.test.ts`
Expected: FAIL — the mapped `actionItems` entries have no `sourceQuote`.

- [ ] **Step 3: Add the field to the IPC payload**

In `electron/main/ipc/handlers.ts`, in the `meetingsGet` handler, change the `actionItems.map` (currently lines 200–204):

```ts
      actionItems: items.map((ai) => ({
        id: ai.id, text: ai.text, ownerName: ai.ownerName,
        dueDate: ai.dueDate, status: ai.status, exportedTo: ai.exportedTo,
        isMine: isMyItem(ai, me),
      })),
```

to:

```ts
      actionItems: items.map((ai) => ({
        id: ai.id, text: ai.text, ownerName: ai.ownerName,
        dueDate: ai.dueDate, status: ai.status, exportedTo: ai.exportedTo,
        sourceQuote: ai.sourceQuote,
        isMine: isMyItem(ai, me),
      })),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/main/ipc/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/handlers.ts electron/main/ipc/handlers.test.ts
git commit -m "feat(ipc): expose action-item source_quote on meetings:get"
```

---

### Task 6: Renderer — "Show source" jumps to and highlights the summary bullet

**Files:**
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx`

No renderer unit test harness exists for these view components (they're verified manually — see the spec's Testing strategy), so this task is implement-then-typecheck rather than TDD. Each edit is a self-contained, reviewable change.

- [ ] **Step 1: Extend the `MeetingDetail` type**

In `electron/renderer/src/views/MeetingDetailView.tsx`, add `sourceQuote` to the `actionItems` element type in the `MeetingDetail` interface (currently the `actionItems: {...}[]` block, lines 41–49) — insert after `exportedTo`:

```ts
    exportedTo: string[];
    sourceQuote: string | null;
    isMine: boolean;
```

- [ ] **Step 2: Lift a provenance target in `MeetingDetailView`**

Below the existing `const [tab, setTab] = useState<Tab>('summary');` (line 74), add:

```ts
  // Provenance jump (#provenance): when the user clicks "Show source" on an
  // action item, we switch to the Summary tab and ask SummaryPanel to
  // highlight the bullet whose text matches `quote`. `nonce` lets re-clicking
  // the same item re-trigger the scroll/highlight even though `quote` is
  // unchanged. Mirrors how `seekSeconds` drives the transcript jump.
  const [provenance, setProvenance] = useState<{ quote: string; nonce: number } | null>(null);
  const showSource = (quote: string): void => {
    setTab('summary');
    setProvenance((p) => ({ quote, nonce: (p?.nonce ?? 0) + 1 }));
  };
```

Thread `showSource` into `CenterPane` — change the `<CenterPane ... />` usage (lines 211–218) to pass `onShowSource={showSource}` and `provenance={provenance}`.

- [ ] **Step 3: Thread the props through `CenterPane`**

In `CenterPane`'s props (currently lines 788–797), add:

```ts
  onShowSource: (quote: string) => void;
  provenance: { quote: string; nonce: number } | null;
```

and destructure them. Pass `provenance` into `SummaryPanel` and `onShowSource` into `ActionItemsPanel`:

```tsx
        {tab === 'summary' && <SummaryPanel meeting={meeting} onReload={onReload} provenance={provenance} />}
```

```tsx
        {tab === 'actions' && <ActionItemsPanel meeting={meeting} onReload={onReload} onShowSource={onShowSource} />}
```

- [ ] **Step 4: Add the "Show source" button to the action row**

Change `ActionItemsPanel`'s props to accept `onShowSource` and pass it to each `ActionItemDisplay`:

```tsx
function ActionItemsPanel({
  meeting, onReload, onShowSource,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
  onShowSource: (quote: string) => void;
}): JSX.Element {
```

In the `.map`, pass it down:

```tsx
            <ActionItemDisplay
              key={it.id}
              item={it}
              onOpen={() => setEditing(it.id)}
              onShowSource={onShowSource}
            />
```

Update `ActionItemDisplay` (currently lines 1303–1330) to render a "Show source" affordance when `item.sourceQuote` is non-null. Because the row itself is a `<button>` (opens the editor), the source affordance is a sibling `<span role="button">` inside a wrapping `<div>` to avoid nesting interactive elements:

```tsx
function ActionItemDisplay({
  item, onOpen, onShowSource,
}: {
  item: MeetingDetail['actionItems'][number];
  onOpen: () => void;
  onShowSource: (quote: string) => void;
}): JSX.Element {
  return (
    <div className="relative">
      <button
        onClick={onOpen}
        className="w-full text-left rounded-lg border border-surface-border bg-surface
                   hover:border-brand-indigo/60 hover:shadow-pop px-3 py-2 transition"
      >
        <div className="text-sm text-ink">{item.text}</div>
        <div className="text-xs text-ink-muted mt-1 flex items-center gap-3">
          {item.ownerName && <span>👤 {item.ownerName}</span>}
          {item.dueDate && <span>📅 {item.dueDate}</span>}
          {item.status === 'done' && (
            <span className="bg-status-okBg text-status-ok font-semibold px-1.5 rounded">DONE</span>
          )}
          {item.exportedTo.length > 0 && (
            <span className="text-ink-muted/70">
              exported to {item.exportedTo.join(', ')}
            </span>
          )}
        </div>
      </button>
      {item.sourceQuote && (
        <span
          role="button"
          tabIndex={0}
          onClick={() => onShowSource(item.sourceQuote!)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onShowSource(item.sourceQuote!); } }}
          title="Show the summary bullet this came from"
          className="absolute top-2 right-2 text-[11px] font-semibold text-brand-indigo/80
                     hover:text-brand-indigo hover:underline cursor-pointer select-none"
        >
          ↦ source
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Highlight the bullet in `SummaryPanel` / `MarkdownPreview`**

Add `provenance` to `SummaryPanel`'s props and forward it to the view-mode `MarkdownPreview`:

```tsx
function SummaryPanel({
  meeting, onReload, provenance,
}: { meeting: MeetingDetail; onReload: () => Promise<void>; provenance: { quote: string; nonce: number } | null }): JSX.Element {
```

Change the view-mode preview render (currently line 1548) to:

```tsx
      {mode === 'view' && <MarkdownPreview source={draft} highlight={provenance} />}
```

(The edit-mode preview on line 1553 stays `<MarkdownPreview source={draft} />` — no highlight while editing.)

Rewrite `MarkdownPreview` (currently lines 1617–1627) to accept an optional `highlight` and, after render, find + highlight + scroll the matching node:

```tsx
function MarkdownPreview({
  source, highlight,
}: {
  source: string;
  highlight?: { quote: string; nonce: number } | null;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Normalize the way we compare item-source text to rendered markdown text:
  // markdown may render "—" / smart quotes differently than the on-disk
  // bullet, and whitespace collapses. Lowercase + strip non-alphanumerics so
  // "Ship the v2 API — Dan" matches the rendered "Ship the v2 API — Dan".
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !highlight?.quote) return;
    const target = norm(highlight.quote);
    if (!target) return;
    // Search list items first (action items are bullets), then paragraphs.
    const nodes = Array.from(root.querySelectorAll('li, p')) as HTMLElement[];
    const hit = nodes.find((n) => norm(n.textContent ?? '').includes(target));
    if (!hit) return;
    hit.classList.add('provenance-flash');
    hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = setTimeout(() => hit.classList.remove('provenance-flash'), 2600);
    return () => clearTimeout(t);
    // `nonce` in the dep list re-runs this when the same item is clicked twice.
  }, [highlight?.quote, highlight?.nonce]);

  return (
    <div ref={rootRef} className="prose prose-sm max-w-none prose-headings:mt-3 prose-p:my-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 6: Add the transient highlight style**

The transcript active line uses `bg-brand-indigo/10 ring-1 ring-brand-indigo/30`. Reuse that look as a fading flash. Add this rule to the renderer's global stylesheet (`electron/renderer/src/index.css` or the equivalent global CSS the project imports — grep for `@tailwind` to find it):

```css
/* Provenance jump: brief highlight on the summary bullet an action item
   was extracted from. Fades out so it draws the eye then gets out of the way. */
.provenance-flash {
  border-radius: 0.375rem;
  animation: provenance-flash 2.6s ease-out;
}
@keyframes provenance-flash {
  0%, 40% { background-color: rgb(99 102 241 / 0.16); box-shadow: 0 0 0 2px rgb(99 102 241 / 0.30); }
  100%    { background-color: transparent; box-shadow: 0 0 0 2px transparent; }
}
```

- [ ] **Step 7: Type-check and run the full suite**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p electron/renderer/tsconfig.json --noEmit && npx vitest run`
(Adjust the renderer tsconfig path to whatever the project uses — grep for `tsconfig` under `electron/renderer`.)
Expected: no type errors; all tests pass.

- [ ] **Step 8: Manual verification**

Run the app, process a meeting, open the Actions tab. Confirm:
- An extracted item whose text matches a summary bullet shows "↦ source"; clicking it switches to the Summary tab and briefly highlights + scrolls to the matching bullet.
- A hand-added item (via "+ Add item") shows no "↦ source".
- Editing the summary so a bullet no longer exists → clicking source lands on the Summary tab with no highlight (graceful no-op, no error).

- [ ] **Step 9: Commit**

```bash
git add electron/renderer/src/views/MeetingDetailView.tsx electron/renderer/src/index.css
git commit -m "feat(ui): click an action item to highlight its summary source"
```

---

## Self-Review

**Spec coverage:** §1 migration → Task 1. §2 repo persistence → Task 2. §3 matcher module → Task 3. §4 extract-stage wiring → Task 4. §5 IPC surface → Task 5. §6 renderer highlight/scroll → Task 6. "What does not change" — no task touches the zod schema, `parseActionItemsLoose`, `ACTION_ITEM_SYSTEM_PROMPT`, the summarize stage, or the failure banner; no LLM call is added. No gaps.

**Placeholder scan:** Every implementation step shows complete code; every run step has a command + expected outcome. The only conditional is Task 5 Step 1–2 (skip the IPC test if no `meetings:get` fixture exists), which is called out explicitly with the repo round-trip + manual verification as the covering safety net — not a TBD.

**Migration pattern match:** Task 1 mirrors the repo's established style exactly — a new `MIGRATIONS` entry with a monotonically-increasing `version` and a bare `ALTER TABLE action_items ADD COLUMN … TEXT;` (identical shape to version 8's `owner_name` and version 10's `error_message`). `runMigrations` applies it in-order inside its existing transaction wrapper; nullable-no-default means old rows upgrade cleanly.

**Type consistency:** `ActionItemWithSource = ActionItem & { sourceQuote?: string | null }` is defined once in the repo (Task 2) and re-declared (non-optional variant) in the matcher (Task 3) as its return type; `replaceForMeeting` accepts the optional-`sourceQuote` form, so the matcher's non-optional output and the pre-existing bare `{text, owner, due_date}` test literals both satisfy it. The renderer `MeetingDetail.actionItems[]` type (Task 6 Step 1) matches the IPC payload shape added in Task 5. `showSource`/`onShowSource`/`provenance` are threaded top-down through `CenterPane` with matching signatures at each hop.

**Ordering note:** Tasks 1→2→3→4 are a hard chain (column before repo before matcher before wiring). Task 5 depends on Task 2 (repo exposes `sourceQuote`). Task 6 depends on Task 5 (IPC payload). Follow the numeric order.

**Risk note:** Task 6's DOM-text highlight is best-effort — if the rendered markdown collapses/reworders the bullet beyond the normalized compare, the jump lands on the Summary tab without a highlight. That's the spec's accepted "silent no-match" degradation, not a bug; the manual-verification step (Task 6 Step 8) exercises it.
