# Editable Transcript + Staleness + Find/Replace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user edit `transcript.md` from the Transcript tab, flag the summary as out-of-date (with a one-click Re-summarize) once the transcript changes, and add a find/replace bar to both editors.

**Architecture:** Pure logic (find/replace, staleness) lives in unit-tested `.ts` modules. A new `meetings:save-transcript` IPC mirrors the existing `meetings:save-summary`. The summary editor's edit-state machinery is extracted into a shared `useDocEditor` hook + `DocEditorToolbar` so the new transcript editor reuses it; a shared `FindReplaceBar` drops into both. Staleness is derived from file mtimes in `meetings:get`.

**Tech Stack:** Electron 30, React 18 + TypeScript, Vitest (`environment: 'node'` — pure-logic and main-process tests only; React components are verified via `npm run build` typecheck + manual run).

**Branch:** `feat/editable-transcript-find-replace` (already checked out; spec committed).

**Conventions:**
- All commits append the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Pure tests (no SQLite): `npx vitest run <file>`. Tests touching `better-sqlite3` (e.g. `handlers.test.ts`): use `npm test` (its `pretest`/`posttest` auto-rebuild the native binding for Node, then back for Electron).
- Reference template for the IPC pieces: the existing `meetings:save-summary` (`saveSummary`) wiring.

---

## File Structure

**Create:**
- `electron/renderer/src/lib/find-replace.ts` — pure `replaceAll` / `countMatches`.
- `electron/renderer/src/lib/find-replace.test.ts` — pure tests.
- `electron/main/ipc/summary-stale.ts` — pure `isSummaryStale(folder)`.
- `electron/main/ipc/summary-stale.test.ts` — pure tests.
- `electron/renderer/src/components/FindReplaceBar.tsx` — the bar UI.
- `electron/renderer/src/components/useDocEditor.ts` — shared edit-state hook.
- `electron/renderer/src/components/DocEditorToolbar.tsx` — shared toolbar (mode toggle + status + Save/Revert).

**Modify:**
- `electron/main/ipc/contracts.ts` — add `meetingsSaveTranscript` channel.
- `electron/preload/index.ts` — add channel to its local `IPC_CHANNELS` + add `saveTranscript` method.
- `electron/main/ipc/handlers.ts` — add `meetings:save-transcript` handler; add `summaryStale` to `meetings:get`.
- `electron/main/ipc/handlers.test.ts` — tests for the new handler + `summaryStale`.
- `electron/renderer/src/views/MeetingDetailView.tsx` — `MeetingDetail` += `summaryStale`; refactor `SummaryPanel` onto the hook/toolbar; add the stale banner; add `TranscriptPanel` edit mode and swap it into the tab.

---

## Task 1: Pure find/replace module

**Files:**
- Create: `electron/renderer/src/lib/find-replace.ts`
- Test: `electron/renderer/src/lib/find-replace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/renderer/src/lib/find-replace.test.ts
import { describe, it, expect } from 'vitest';
import { countMatches, replaceAll } from './find-replace';

const ci = { caseInsensitive: true, wholeWord: false };
const cs = { caseInsensitive: false, wholeWord: false };
const ww = { caseInsensitive: true, wholeWord: true };

describe('countMatches', () => {
  it('counts case-insensitive matches', () => {
    expect(countMatches('Dan and dan and DAN', 'dan', ci)).toBe(3);
  });
  it('respects case sensitivity', () => {
    expect(countMatches('Dan and dan', 'dan', cs)).toBe(1);
  });
  it('whole-word does not match inside larger words', () => {
    expect(countMatches('Dan met Danielle', 'Dan', ww)).toBe(1);
  });
  it('treats the find term literally (regex specials)', () => {
    expect(countMatches('a.b and axb', 'a.b', cs)).toBe(1);
    expect(countMatches('C++ and C', 'C++', cs)).toBe(1);
  });
  it('empty find term counts zero', () => {
    expect(countMatches('anything', '', ci)).toBe(0);
  });
});

describe('replaceAll', () => {
  it('replaces every occurrence and reports the count', () => {
    const { result, count } = replaceAll('Dan, dan, DAN', 'dan', 'Dana', ci);
    expect(result).toBe('Dana, Dana, Dana');
    expect(count).toBe(3);
  });
  it('inserts the replacement literally (no $ substitution)', () => {
    const { result } = replaceAll('price X', 'X', '$5 & up', cs);
    expect(result).toBe('price $5 & up');
  });
  it('whole-word leaves substrings of larger words intact', () => {
    const { result } = replaceAll('Dan met Danielle', 'Dan', 'Don', ww);
    expect(result).toBe('Don met Danielle');
  });
  it('no match returns the text unchanged with count 0', () => {
    expect(replaceAll('hello', 'zzz', 'q', ci)).toEqual({ result: 'hello', count: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run electron/renderer/src/lib/find-replace.test.ts`
Expected: FAIL — `Failed to resolve import "./find-replace"`.

- [ ] **Step 3: Write the implementation**

```ts
// electron/renderer/src/lib/find-replace.ts
export interface FindOptions {
  caseInsensitive: boolean;
  wholeWord: boolean;
}

// Escape every regex metacharacter so the user's find term is matched
// literally — a name like "C++" or an initial like "a.b" must not be read
// as a pattern.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPattern(find: string, opts: FindOptions): RegExp | null {
  if (find === '') return null;
  let body = escapeRegExp(find);
  if (opts.wholeWord) body = `\\b${body}\\b`;
  return new RegExp(body, opts.caseInsensitive ? 'gi' : 'g');
}

export function countMatches(text: string, find: string, opts: FindOptions): number {
  const re = buildPattern(find, opts);
  if (!re) return 0;
  const m = text.match(re);
  return m ? m.length : 0;
}

export function replaceAll(
  text: string,
  find: string,
  replace: string,
  opts: FindOptions,
): { result: string; count: number } {
  const re = buildPattern(find, opts);
  if (!re) return { result: text, count: 0 };
  let count = 0;
  // A function replacer inserts its return value verbatim — so `$&`, `$1`,
  // etc. in the replacement are NOT interpreted (which a string replacer
  // would do). That's the behavior we want for plain text replacement.
  const result = text.replace(re, () => {
    count += 1;
    return replace;
  });
  return { result, count };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/renderer/src/lib/find-replace.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/src/lib/find-replace.ts electron/renderer/src/lib/find-replace.test.ts
git commit -m "feat(find-replace): pure replaceAll/countMatches with case + whole-word options"
```

---

## Task 2: Pure summary-staleness module

**Files:**
- Create: `electron/main/ipc/summary-stale.ts`
- Test: `electron/main/ipc/summary-stale.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/ipc/summary-stale.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSummaryStale } from './summary-stale';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-stale-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(name: string, mtimeMs: number): void {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
}

describe('isSummaryStale', () => {
  it('is stale when transcript.md is newer than summary.md', () => {
    write('summary.md', 1_000_000);
    write('transcript.md', 2_000_000);
    expect(isSummaryStale(dir)).toBe(true);
  });
  it('is fresh when summary.md is newer (e.g. just re-summarized)', () => {
    write('transcript.md', 1_000_000);
    write('summary.md', 2_000_000);
    expect(isSummaryStale(dir)).toBe(false);
  });
  it('is not stale when summary.md is missing', () => {
    write('transcript.md', 1_000_000);
    expect(isSummaryStale(dir)).toBe(false);
  });
  it('is not stale when transcript.md is missing', () => {
    write('summary.md', 1_000_000);
    expect(isSummaryStale(dir)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run electron/main/ipc/summary-stale.test.ts`
Expected: FAIL — `Failed to resolve import "./summary-stale"`.

- [ ] **Step 3: Write the implementation**

```ts
// electron/main/ipc/summary-stale.ts
import fs from 'node:fs';
import path from 'node:path';

/** The summary is "stale" when transcript.md has been modified more recently
 *  than summary.md — i.e. the user edited the transcript after the summary
 *  was generated. Both files must exist; otherwise there is nothing to
 *  compare and we report not-stale. Re-summarizing rewrites summary.md and
 *  clears staleness on its own; editing the summary touches only summary.md,
 *  so it never marks itself stale. */
export function isSummaryStale(meetingFolder: string): boolean {
  const transcript = path.join(meetingFolder, 'transcript.md');
  const summary = path.join(meetingFolder, 'summary.md');
  if (!fs.existsSync(transcript) || !fs.existsSync(summary)) return false;
  return fs.statSync(transcript).mtimeMs > fs.statSync(summary).mtimeMs;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run electron/main/ipc/summary-stale.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/summary-stale.ts electron/main/ipc/summary-stale.test.ts
git commit -m "feat(summary): mtime-derived isSummaryStale helper"
```

---

## Task 3: `meetings:save-transcript` channel + handler, and `summaryStale` in `meetings:get`

**Files:**
- Modify: `electron/main/ipc/contracts.ts` (add channel near `meetingsSaveSummary`)
- Modify: `electron/main/ipc/handlers.ts` (import `isSummaryStale`; add handler; add field to `meetings:get`)
- Test: `electron/main/ipc/handlers.test.ts`

- [ ] **Step 1: Add the channel constant**

In `electron/main/ipc/contracts.ts`, directly below the `meetingsSaveSummary: 'meetings:save-summary',` line, add:

```ts
  meetingsSaveTranscript: 'meetings:save-transcript',
```

- [ ] **Step 2: Write the failing tests**

`handlers.test.ts` registers handlers against a **fully-mocked** `services` object and a fake `ipc.handle` — it never uses a real DB. Match that style: capture the registered handler from a mock `ipc.handle`, then call it directly. The `meetings:save-transcript` handler only touches `services.meetings.findById` and `services.libraryRoot`, so it's cheap to invoke against a temp folder. (The deeper `summaryStale` correctness is already covered by `summary-stale.test.ts` in Task 2; here we only assert the new channel exists and the writer works.)

Add these imports at the top of `handlers.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { meetingFolderPath } from '../storage/meeting-folder.js';
```

Add this factory + helper and the new `describe` block (the `baseServices()` body is a copy of the inline services mock the existing registration test uses, plus a `findById`):

```ts
function baseServices(libraryRoot = '/tmp'): any {
  return {
    meetings: { listAll: () => [], findById: () => null },
    speakers: { list: () => [] },
    actionItems: { listByMeeting: () => [] },
    settings: { getAll: () => ({}), get: () => '', set: () => {} },
    lmStudio: { listModels: async () => [] },
    recordingManager: { start: async () => ({ sessionId: 's', outputPath: '/o' }), stop: async () => {}, state: () => 'idle', on: () => {} },
    appEnumerator: { list: async () => [] },
    helperPath: '/bin/meeting-notes-tap',
    roster: { confirmSpeaker: () => 'id', confirmSpeakerFor: () => {} },
    pipeline: { enqueue: () => {}, getStatus: () => ({ paused: false, currentId: null, queueLength: 0, queueIds: [] }), pause: () => {}, resume: () => {}, clearQueue: () => [] },
    exporters: {},
    libraryRoot,
  };
}

function captureHandlers(services: any): Map<string, (...a: any[]) => any> {
  const handlers = new Map<string, (...a: any[]) => any>();
  const fakeIpc = { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) } as any;
  registerIpcHandlers(fakeIpc, services);
  return handlers;
}

describe('meetings:save-transcript handler', () => {
  it('is registered', () => {
    expect(captureHandlers(baseServices()).has('meetings:save-transcript')).toBe(true);
  });

  it('writes transcript.md and returns the markdown', () => {
    const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-h-'));
    const meeting = { id: 'm1', slug: '2026-01-01-test' };
    const services = baseServices(libraryRoot);
    services.meetings.findById = (id: string) => (id === 'm1' ? meeting : null);
    const fn = captureHandlers(services).get('meetings:save-transcript')!;
    const md = '[Alice 00:00] hello';
    const returned = fn({}, 'm1', md); // handler is synchronous
    expect(returned).toBe(md);
    const folder = meetingFolderPath(libraryRoot, meeting.slug);
    expect(fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8')).toBe(md);
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  });

  it('rejects a too-large transcript', () => {
    const services = baseServices();
    services.meetings.findById = () => ({ id: 'm1', slug: 's' });
    const fn = captureHandlers(services).get('meetings:save-transcript')!;
    expect(() => fn({}, 'm1', 'x'.repeat(5_000_001))).toThrow(/too large/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run electron/main/ipc/handlers.test.ts`
Expected: FAIL — `meetings:save-transcript` is not registered (handler doesn't exist yet).
(If this errors with a `better-sqlite3` ABI/DLOPEN message instead, run via `npm test -- electron/main/ipc/handlers.test.ts`, which rebuilds the binding for Node first.)

- [ ] **Step 4: Implement the handler + the `summaryStale` field**

In `electron/main/ipc/handlers.ts`, add the import near the other local imports:

```ts
import { isSummaryStale } from './summary-stale.js';
```

In the `meetings:get` handler, in the returned object (alongside `summaryMd: read(...)`), add:

```ts
      summaryStale: isSummaryStale(folder),
```

Add the new handler immediately after the `meetingsSaveSummary` handler block:

```ts
  ipc.handle(IPC_CHANNELS.meetingsSaveTranscript, (_e, id: unknown, markdown: unknown) => {
    if (typeof id !== 'string' || typeof markdown !== 'string') throw new Error('invalid args');
    // Cap at ~5MB to defang a runaway editor sending a giant blob; real
    // transcripts are well under 1MB. Mirrors meetings:save-summary.
    if (markdown.length > 5_000_000) throw new Error('transcript too large');
    const meeting = s.meetings.findById(id);
    if (!meeting) throw new Error('meeting not found');
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'transcript.md'), markdown);
    return markdown;
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- electron/main/ipc/handlers.test.ts`
Expected: PASS (new cases green).

- [ ] **Step 6: Commit**

```bash
git add electron/main/ipc/contracts.ts electron/main/ipc/handlers.ts electron/main/ipc/handlers.test.ts
git commit -m "feat(ipc): meetings:save-transcript + summaryStale on meetings:get"
```

---

## Task 4: Preload `saveTranscript` + `MeetingDetail.summaryStale` type

**Files:**
- Modify: `electron/preload/index.ts`
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx` (interface only)

- [ ] **Step 1: Add the channel to the preload's local `IPC_CHANNELS`**

In `electron/preload/index.ts`, in the `const IPC_CHANNELS = { … }` literal, below `meetingsSaveSummary: 'meetings:save-summary',` add:

```ts
  meetingsSaveTranscript: 'meetings:save-transcript',
```

- [ ] **Step 2: Add the `saveTranscript` method**

In the `meetings:` object, directly below the `saveSummary` method, add:

```ts
    // Overwrite transcript.md on disk with user-edited markdown. Mirrors
    // saveSummary — the renderer owns the editing UX; main just writes bytes
    // and returns the saved markdown so the caller can confirm the round-trip.
    saveTranscript: (id: string, markdown: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.meetingsSaveTranscript, id, markdown) as Promise<string>,
```

- [ ] **Step 3: Add `summaryStale` to the `MeetingDetail` interface**

In `electron/renderer/src/views/MeetingDetailView.tsx`, inside `interface MeetingDetail { … }` (starts line 24), next to `summaryMd`, add:

```ts
  summaryStale: boolean;
```

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: PASS (tsc clean, vite build succeeds). `MeetingNotesApi` now exposes `saveTranscript`.

- [ ] **Step 5: Commit**

```bash
git add electron/preload/index.ts electron/renderer/src/views/MeetingDetailView.tsx
git commit -m "feat(preload): saveTranscript bridge + summaryStale on MeetingDetail"
```

---

## Task 5: `FindReplaceBar` component

**Files:**
- Create: `electron/renderer/src/components/FindReplaceBar.tsx`

(No unit test — the env is `node`, so React components are verified by typecheck + manual run. The risky logic is already tested in Task 1.)

- [ ] **Step 1: Write the component**

```tsx
// electron/renderer/src/components/FindReplaceBar.tsx
import { useState } from 'react';
import { countMatches, replaceAll } from '../lib/find-replace';

/** Find + replace-all over the host editor's current text. It does not own
 *  the text — it calls `onChange` with the replaced string, which marks the
 *  editor dirty; the user still presses Save to persist. Scoped to one
 *  editor; replacements never cross into the other document. */
export function FindReplaceBar({
  value, onChange,
}: { value: string; onChange: (next: string) => void }): JSX.Element {
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [caseInsensitive, setCaseInsensitive] = useState(true);
  const [wholeWord, setWholeWord] = useState(false);

  const opts = { caseInsensitive, wholeWord };
  const count = countMatches(value, find, opts);

  function applyAll(): void {
    if (count === 0) return;
    onChange(replaceAll(value, find, replace, opts).result);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-surface-border bg-surface-sunken/50 p-2 text-sm">
      <input
        value={find}
        onChange={(e) => setFind(e.target.value)}
        placeholder="Find"
        className="flex-1 min-w-[8rem] p-1.5 border border-surface-border rounded-md bg-surface
                   focus:outline-none focus:border-brand-indigo"
      />
      <input
        value={replace}
        onChange={(e) => setReplace(e.target.value)}
        placeholder="Replace with"
        className="flex-1 min-w-[8rem] p-1.5 border border-surface-border rounded-md bg-surface
                   focus:outline-none focus:border-brand-indigo"
      />
      <label className="flex items-center gap-1 text-xs text-ink-muted select-none">
        <input type="checkbox" checked={caseInsensitive}
               onChange={(e) => setCaseInsensitive(e.target.checked)} />
        Ignore case
      </label>
      <label className="flex items-center gap-1 text-xs text-ink-muted select-none">
        <input type="checkbox" checked={wholeWord}
               onChange={(e) => setWholeWord(e.target.checked)} />
        Whole word
      </label>
      <span className="text-xs text-ink-muted tabular-nums min-w-[5rem]">
        {find === '' ? '' : `${count} match${count === 1 ? '' : 'es'}`}
      </span>
      <button
        onClick={applyAll}
        disabled={count === 0}
        className="px-2.5 py-1 rounded-md text-xs font-semibold bg-brand-indigo text-white
                   disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Replace all
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add electron/renderer/src/components/FindReplaceBar.tsx
git commit -m "feat(ui): shared FindReplaceBar (find, replace-all, case/whole-word, count)"
```

---

## Task 6: Extract `useDocEditor` + `DocEditorToolbar`, refactor `SummaryPanel` onto them

This is a behavior-preserving refactor. Verified by `npm run build` + manual check that the summary editor still saves/reverts/re-seeds. Read `SummaryPanel`/`SummaryToolbar` in `MeetingDetailView.tsx` (≈ lines 1394–1525) before editing.

**Files:**
- Create: `electron/renderer/src/components/useDocEditor.ts`
- Create: `electron/renderer/src/components/DocEditorToolbar.tsx`
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx`

- [ ] **Step 1: Create the hook**

```ts
// electron/renderer/src/components/useDocEditor.ts
import { useEffect, useRef, useState } from 'react';

export interface DocEditor {
  draft: string;
  setDraft: (v: string) => void;
  dirty: boolean;
  saving: boolean;
  savedAt: Date | null;
  error: string | null;
  save: () => Promise<void>;
  revert: () => void;
}

/** Shared edit-state machinery for the summary and transcript editors:
 *  draft vs on-disk baseline, dirty tracking, save via the injected `writer`,
 *  revert, and a re-seed when the underlying document changes on disk (a
 *  re-run) WITHOUT clobbering an in-progress edit. `onSaved` runs after a
 *  successful write (callers use it to flip back to view + reload). */
export function useDocEditor(
  original: string,
  isEditing: boolean,
  writer: (markdown: string) => Promise<unknown>,
  onSaved?: () => void,
): DocEditor {
  const [savedValue, setSavedValue] = useState(original);
  const [draft, setDraft] = useState(original);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prevOriginalRef = useRef(original);
  useEffect(() => {
    if (prevOriginalRef.current === original) return;
    prevOriginalRef.current = original;
    if (!isEditing) { setDraft(original); setSavedValue(original); }
  }, [original, isEditing]);

  const dirty = draft !== savedValue;

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    setSaving(true); setError(null);
    try {
      await writer(draft);
      setSavedValue(draft);
      setSavedAt(new Date());
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function revert(): void { setDraft(original); setError(null); }

  return { draft, setDraft, dirty, saving, savedAt, error, save, revert };
}
```

- [ ] **Step 2: Create the toolbar**

Port the existing `SummaryToolbar` JSX verbatim into a generic component (it already only uses `view`/`edit` with labels `View`/`Edit`):

```tsx
// electron/renderer/src/components/DocEditorToolbar.tsx
export type DocMode = 'view' | 'edit';

export function DocEditorToolbar({
  mode, onMode, dirty, saving, savedAt, error, onSave, onRevert,
}: {
  mode: DocMode;
  onMode: (m: DocMode) => void;
  dirty: boolean;
  saving: boolean;
  savedAt: Date | null;
  error: string | null;
  onSave: () => Promise<void> | void;
  onRevert: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <div className="inline-flex bg-surface-sunken rounded-lg p-0.5 text-xs font-semibold">
        {(['view', 'edit'] as const).map((m) => (
          <button
            key={m}
            onClick={() => onMode(m)}
            className={`px-2.5 py-1 rounded-md transition-colors ${
              mode === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {m === 'view' ? 'View' : 'Edit'}
          </button>
        ))}
      </div>
      <div className="flex-1 min-w-0">
        {error && <span className="text-xs text-rose-600 truncate" title={error}>{error}</span>}
        {!error && dirty && <span className="text-xs text-ink-muted">Unsaved changes</span>}
        {!error && !dirty && savedAt && (
          <span className="text-xs text-status-ok">
            ✓ Saved {savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
      {dirty && (
        <button
          onClick={onRevert}
          className="text-xs text-ink-muted hover:text-ink px-2 py-1 rounded hover:bg-surface-sunken"
        >
          Revert
        </button>
      )}
      <button
        onClick={() => void onSave()}
        disabled={!dirty || saving}
        className="text-xs font-semibold px-3 py-1 rounded-md bg-brand-indigo text-white disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
```

> Confirm the trailing Save-button markup matches the original `SummaryToolbar` (lines ≈ 1521–1525). Copy the original's exact classes/labels if they differ from the above.

- [ ] **Step 3: Refactor `SummaryPanel` to use the hook + toolbar**

Replace the body of `SummaryPanel` (keep its signature) with:

```tsx
function SummaryPanel({
  meeting, onReload,
}: { meeting: MeetingDetail; onReload: () => Promise<void> }): JSX.Element {
  const original = meeting.summaryMd ?? '';
  const [mode, setMode] = useState<DocMode>('view');
  const ed = useDocEditor(
    original,
    mode === 'edit',
    (md) => api.meetings.saveSummary(meeting.id, md),
    () => { setMode('view'); void onReload(); },
  );

  if (!original && !ed.dirty) {
    return <Placeholder text="Summary will appear after the summarize stage." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <DocEditorToolbar
        mode={mode} onMode={setMode}
        dirty={ed.dirty} saving={ed.saving} savedAt={ed.savedAt} error={ed.error}
        onSave={ed.save} onRevert={ed.revert}
      />
      {mode === 'view' && <MarkdownPreview source={ed.draft} />}
      {mode === 'edit' && (
        <div className="flex flex-col gap-3">
          <FindReplaceBar value={ed.draft} onChange={ed.setDraft} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <MarkdownEditor value={ed.draft} onChange={ed.setDraft} />
            <div className="border border-surface-border rounded-lg p-4 bg-surface-sunken/40 overflow-auto max-h-[60vh]">
              <MarkdownPreview source={ed.draft} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

Delete the now-unused `SummaryMode` type and the old `SummaryToolbar` function. Add imports at the top of the file:

```ts
import { useDocEditor } from '../components/useDocEditor';
import { DocEditorToolbar, type DocMode } from '../components/DocEditorToolbar';
import { FindReplaceBar } from '../components/FindReplaceBar';
```

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: PASS. Resolve any leftover references to the deleted `SummaryToolbar`/`SummaryMode`.

- [ ] **Step 5: Manual smoke check**

Run the app (`./scripts/start.sh --dev`, or the project `run` skill). Open a processed meeting → Summary tab → Edit: confirm the find/replace bar appears, editing marks "Unsaved changes", Save persists and returns to View, Revert restores. Behavior must match pre-refactor.

- [ ] **Step 6: Commit**

```bash
git add electron/renderer/src/components/useDocEditor.ts electron/renderer/src/components/DocEditorToolbar.tsx electron/renderer/src/views/MeetingDetailView.tsx
git commit -m "refactor(ui): extract useDocEditor + DocEditorToolbar; summary editor gets find/replace"
```

---

## Task 7: Stale-summary banner + Re-summarize

**Files:**
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx` (`SummaryPanel`)

- [ ] **Step 1: Add the banner**

In `SummaryPanel`, add a `busy` state for the rerun and render a banner above the toolbar when stale and not mid-edit. Insert after the `useDocEditor` call:

```tsx
  const [resummarizing, setResummarizing] = useState(false);
  async function reSummarize(): Promise<void> {
    setResummarizing(true);
    try {
      await api.meetings.rerun(meeting.id, 'summarizing');
      await onReload();
    } finally {
      setResummarizing(false);
    }
  }
  const showStale = meeting.summaryStale && !ed.dirty && mode === 'view';
```

Then, just inside the returned `<div className="flex flex-col gap-3">`, before `<DocEditorToolbar …/>`:

```tsx
      {showStale && (
        <div className="flex items-center gap-3 rounded-lg border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-sm">
          <span className="flex-1 text-status-warn-text">
            Transcript edited after this summary was generated — it may be out of date.
          </span>
          <button
            onClick={() => void reSummarize()}
            disabled={resummarizing}
            className="px-2.5 py-1 rounded-md text-xs font-semibold bg-brand-indigo text-white disabled:opacity-40"
          >
            {resummarizing ? 'Re-summarizing…' : 'Re-summarize'}
          </button>
        </div>
      )}
```

> `status-warn` / `status-warn-bg` / `status-warn-text` are existing palette tokens (see `tailwind.config.js`). `rerun(id, 'summarizing')` is the existing "just summary + actions" path, so action items refresh too.

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add electron/renderer/src/views/MeetingDetailView.tsx
git commit -m "feat(ui): stale-summary banner with one-click Re-summarize"
```

---

## Task 8: Editable `TranscriptPanel`

The current Transcript tab renders the click-to-seek view (a component around lines 754–870 — read it first; note its props for `currentTime`/`onSeek`). Wrap it in a `TranscriptPanel` that adds a View/Edit toggle. Edit is offered only when `transcript.md` exists (`meeting.transcriptMd !== null`).

**Files:**
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx`

- [ ] **Step 1: Add `TranscriptPanel`**

Add a new component. Replace `<ExistingTranscriptView … />` (the current click-to-seek component name as found in the file) with the wrapper; keep passing the same `currentTime`/`onSeek`/`meeting` props through to View mode:

```tsx
function TranscriptPanel({
  meeting, onReload, currentTime, onSeek,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
  currentTime: number;
  onSeek: (t: number) => void;
}): JSX.Element {
  const canEdit = meeting.transcriptMd !== null;
  const original = meeting.transcriptMd ?? '';
  const [mode, setMode] = useState<DocMode>('view');
  const ed = useDocEditor(
    original,
    mode === 'edit',
    (md) => api.meetings.saveTranscript(meeting.id, md),
    () => { setMode('view'); void onReload(); },
  );

  // Pre-merge / raw transcript: nothing durable to write yet — view only.
  if (!canEdit) {
    return <TranscriptView meeting={meeting} currentTime={currentTime} onSeek={onSeek} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <DocEditorToolbar
        mode={mode} onMode={setMode}
        dirty={ed.dirty} saving={ed.saving} savedAt={ed.savedAt} error={ed.error}
        onSave={ed.save} onRevert={ed.revert}
      />
      {mode === 'view' && (
        <TranscriptView meeting={meeting} currentTime={currentTime} onSeek={onSeek} />
      )}
      {mode === 'edit' && (
        <div className="flex flex-col gap-3">
          <FindReplaceBar value={ed.draft} onChange={ed.setDraft} />
          <textarea
            value={ed.draft}
            onChange={(e) => ed.setDraft(e.target.value)}
            spellCheck={false}
            className="w-full min-h-[60vh] font-mono text-sm p-3 border border-surface-border rounded-lg bg-surface
                       focus:outline-none focus:border-brand-indigo resize-y"
          />
        </div>
      )}
    </div>
  );
}
```

> Replace `TranscriptView`, `meeting`, `currentTime`, `onSeek` with the actual component name and prop names used in the file today. If the existing view component is currently rendered inline in the tab switch, factor its current call into the `TranscriptView` references above unchanged.

- [ ] **Step 2: Swap it into the tab**

Find where the transcript tab renders today (the `tab === 'transcript'` branch, ≈ line 740). Replace the existing transcript view element with:

```tsx
        {tab === 'transcript' && (
          <TranscriptPanel
            meeting={meeting}
            onReload={onReload}
            currentTime={currentTime}
            onSeek={onSeek}
          />
        )}
```

Match the surrounding prop names (`onReload`, `currentTime`, `onSeek`) to those already in scope at that call site.

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual smoke check**

Run the app. Open a processed meeting → Transcript tab → Edit: textarea shows raw `transcript.md`; fix a name with the find/replace bar (Replace all); Save. Switch to Summary tab → the stale banner appears. Click Re-summarize → after it completes, the banner clears and the new summary reflects the corrected name. Confirm a still-processing meeting (no `transcript.md`) shows the view with no Edit toggle.

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/src/views/MeetingDetailView.tsx
git commit -m "feat(ui): editable transcript with find/replace; marks summary stale on save"
```

---

## Task 9: Full verification

- [ ] **Step 1: Full test suite (binding auto-managed)**

Run: `npm test`
Expected: all green (418 existing + the new pure/handler tests).

- [ ] **Step 2: Lint + build**

Run: `npm run lint && npm run build`
Expected: no errors.

- [ ] **Step 3: End-to-end manual pass**

Edit transcript → Replace all a recurring name → Save → Summary stale banner → Re-summarize → banner clears, summary + action items reflect the fix. Edit summary independently with its own find/replace → Save (editing summary does NOT raise the stale banner).

- [ ] **Step 4: Restore the native binding for the app if needed**

If you ran single-file `npx vitest` at any point (which leaves the binding built for Node), restore it before launching the packaged app: `npm run rebuild:electron`. (`npm test` already restores it via `posttest`.)

---

## Self-review notes (coverage)

- Editable transcript → Tasks 3 (IPC), 4 (preload), 8 (UI).
- Find/replace (both editors) → Task 1 (logic), 5 (bar), 6 (summary), 8 (transcript).
- Staleness banner + Re-summarize → Tasks 2 (logic), 3 (field), 7 (UI).
- Shared-editor extraction → Task 6.
- Edit only when `transcript.md` exists → Task 8 (`canEdit`).
- Independent editors / no cross-apply, no regex, no auto-rerun → honored throughout (out-of-scope items never appear).
