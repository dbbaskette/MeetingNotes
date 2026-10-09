# Storage Consolidation (Option B) — Design

**Date:** 2026-07-02
**Status:** Proposed — awaiting review

## Problem

MeetingNotes scatters its data across three top-level locations, which is confusing:

| What | Where today | Set by |
| --- | --- | --- |
| Recordings (mixed m4a + `.voice`/`.system` stems) | `~/Music/MeetingNotes/` | **hardcoded** (`index.ts:197`), not a setting |
| Library — `db.sqlite` + `meetings/<slug>/` (transcript, summary, action items, `audio` symlink) | `~/Documents/MeetingNotes/` | `libraryPath` |
| Whisper models (`ggml-*.bin`, GBs) | `~/Library/Application Support/MeetingNotes/whisper-models/` | derived (`whisper/supervisor.ts`) |
| pyannote models + HF token (GBs) | `~/.cache/huggingface/` | hard-coded by the HF library |
| Logs | `~/Library/Logs/MeetingNotes/` | macOS convention |

Two hard constraints rule out "everything in one folder":
- `~/Documents` is frequently **iCloud-synced** ("Desktop & Documents Folders"), so putting GBs of recordings + models there silently uploads them.
- The HF/pyannote cache path is hard-coded by the Hugging Face library and can't be relocated.

## Decision — Option B: idiomatic split, user-facing scatter collapsed

Collapse the data the user *thinks about* into **one Library root**, keep re-downloadable/derived data in the conventional macOS location, and make the whole map legible in Settings.

- **User data → the Library root.** Recordings move *into* the library as `recordings/`. So `db.sqlite`, `meetings/`, and `recordings/` all live under one folder (`~/Documents/MeetingNotes/` by default, relocatable).
- **App-managed data stays in App Support.** Whisper models and logs remain under `~/Library/Application Support/MeetingNotes/` — the correct home for re-downloadable/derived data, and it keeps GBs out of iCloud.
- **HF/pyannote cache is left where the library demands** (`~/.cache/huggingface/`).
- **A new Settings → Storage panel** lists every location with a **Reveal in Finder** button and a one-line rationale, so the remaining (rarely-touched) split is transparent instead of surprising.

### Target layout

```
~/Documents/MeetingNotes/            ← Library root (one setting: libraryPath)
├── db.sqlite
├── recordings/                      ← NEW home (was ~/Music/MeetingNotes)
│   ├── recording-<ts>-<id>.m4a
│   ├── recording-<ts>-<id>.voice.m4a
│   └── recording-<ts>-<id>.system.m4a
├── meetings/<slug>/                 ← audio symlink now points into ../recordings
└── speakers/

~/Library/Application Support/MeetingNotes/   ← app-managed, out of iCloud
├── whisper-models/ggml-*.bin
~/Library/Logs/MeetingNotes/app.log
~/.cache/huggingface/                          ← unchanged (HF-owned)
```

## Changes

### 1. Recordings dir derives from the Library root
`electron/main/index.ts:197` currently hardcodes `recordingsDir = ~/Music/MeetingNotes`. Change it to `path.join(libraryPath, 'recordings')` (created on launch). The `RecordingManager` writes there; new recordings land under the library automatically. No new setting — it's derived from `libraryPath`, so relocating the library moves recordings with it.

### 2. Watch paths (back-compat drops keep working)
The chokidar watcher (`index.ts:281`) currently watches `[audioWatchPath, recordingsDir, ~/Music/Audio Hijack]`. New set: `[<library>/recordings, ~/Music/MeetingNotes (legacy), ~/Music/Audio Hijack (legacy), audioWatchPath if set]`. So the new recordings dir is watched, and files dropped into the old `~/Music/MeetingNotes` are still caught during and after the transition.

### 3. `audioWatchPath` setting → optional extra drop folder
Today it doubles as "where the recorder writes" and "where drops are watched," defaulting to `~/Music/MeetingNotes`. Going forward the recorder writes to the derived `recordings/` dir, so `audioWatchPath` becomes purely an **optional additional watch folder** (default empty). The legacy `~/Music/MeetingNotes` is always watched regardless, so existing drop habits don't break. *(Open question 1 — confirm we default it empty vs. keep the legacy default.)*

### 4. Settings → Storage panel
Replace the current standalone "Recordings folder" and STT-model-path prose with a single **Storage** section:
- **Library** (`libraryPath`) — recordings, meetings, database. Editable + Reveal.
- **Models** (App Support / whisper-models) — Reveal. "Re-downloadable; kept out of iCloud."
- **Logs** (`~/Library/Logs/MeetingNotes`) — Reveal.
- **AI model cache** (`~/.cache/huggingface`) — Reveal. "Shared with other Hugging Face tools."
Each row: label, path (mono, tabular), a Reveal-in-Finder button; the Library row keeps its existing edit control.

### 5. One-time, opt-in migration for existing installs
New installs need nothing (they start in the new layout). Existing installs get a guided move:

- **Trigger:** on launch, if `~/Music/MeetingNotes` contains `recording-*.m4a` files AND `<library>/recordings` doesn't yet hold them, surface a dismissible banner / Settings action: *"Consolidate recordings into your library folder?"* with a before/after and the byte count to move. Never silent.
- **Steps (safe + reversible):**
  1. `mkdir -p <library>/recordings`.
  2. **Copy** (not move) each `recording-*.m4a` + `.voice`/`.system` stems from `~/Music/MeetingNotes` into `<library>/recordings`, verifying size after each copy.
  3. In a single SQLite transaction, rewrite every meeting's `audio_path` from the old path to the new one.
  4. Re-point each meeting folder's `audio` symlink (`meeting-folder.ts` heals stale links already — reuse that path).
  5. Only after all rows + symlinks are updated and verified, delete the originals from `~/Music/MeetingNotes` (or leave them and just stop watching — *open question 2*).
  - If any step fails, stop: the originals are untouched (we copied), the DB transaction rolls back, and the app keeps using the old paths. The migration is re-runnable.
- **Reversibility:** because we copy-then-verify-then-delete, an interrupted migration never loses audio; worst case is a duplicate the user can clean up (and we can detect on next run).

## What does not change

Whisper models and logs stay in App Support; the HF cache stays put; `meetings/`, `db.sqlite`, and the meeting-folder layout are unchanged except that the audio symlink target moves. The pipeline, recorder mechanics, and watcher dedup logic are unchanged.

## Error handling

- Migration failures are non-destructive (copy-first) and reported with the specific file/row that failed; the app continues on the old layout.
- If `<library>/recordings` isn't writable (e.g., library on a read-only volume), the migration aborts with an actionable message and the recorder falls back to a clear error rather than writing nowhere.

## Testing strategy

- **Pure migration planner** (unit-tested): given a list of old recording paths + meeting rows, produce the copy plan and the `audio_path` rewrites — no I/O, thoroughly tested for edge cases (missing stems, already-migrated, path with the old dir as a substring).
- **Repo/DB test**: `audio_path` rewrite in a transaction over a temp SQLite db.
- **Symlink re-point test** over a temp dir (reuse `createMeetingFolder`'s heal path).
- **Derived-dir test**: recorder + watcher use `<library>/recordings`.
- Settings Storage panel: pure path-derivation helpers unit-tested; the React panel is type-checked + manually verified (repo has no DOM test harness).

## Open questions for review

1. **`audioWatchPath` default** — go empty (recordings dir is the default, cleaner) or keep the legacy `~/Music/MeetingNotes` as its default for one release?
2. **After migration** — delete the originals in `~/Music/MeetingNotes`, or leave them in place and just stop treating that folder as primary (safer, but leaves duplicates)?
3. **Models too?** — Option B keeps whisper models in App Support (out of iCloud). Confirm you don't want a toggle to relocate models under the library for users who'd rather have literally everything in one place (accepting the iCloud/size trade-off).
