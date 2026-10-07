# Epic 243 execution record

Approved scope: #243 and its 15 children. Base main `1be1704`, branch
`codex/epic-243`. Implement, verify, push PR and merge. Keep version 1.14.0;
no release/installer, real recording/account export, or live-library restore.

## Ordered slices

- [x] #165/#164: user-local Monday–Sunday weeks, UTC instants for new data;
      non-destructive legacy interpretation; content-based narrative revision,
      one generation owner per week and no stale write after an edit.
- [x] #214/#233/#213: shared accessible modal lifecycle and stable focus;
      explicit keyboard row action/selection mode; retained in-session navigation
      context and lightweight sanitized browse preferences (no implicit query storage).
- [x] #229/#236/#234/#9: predictable new-arrival baseline/acknowledgment;
      explicit inline Move/recent choices, bounded actionable group counts,
      stale-safe native/toast move Undo, optional capture titles plus Rename after Stop.
- [x] #212/#211/#181: independently owned cancellable search with truthful
      completion contracts; measured bounded transcript rendering and whole-text
      search/copy/seeking; shared server-side facets and explicitly saved filters.
- [x] #195/#182/#235: identity-preserving immediate item Undo; optimistic
      Weekly task controls with rollback/provenance; explicit portable validated
      whole-library backup with consistent SQLite and safe idle/write coordination.

## UI and privacy contract

Reuse existing surface/ink/brand/status tokens, fonts and inline expandable groups;
keep Ungrouped first. Use compact nonzero badges, visible selection cues and
sentence-case actions. New controls extend existing sections/dialogs, not a new
dashboard or mandatory recording-title modal. Dialogs trap focus and protect busy
mutations. Escape is owned by the topmost flow. Ordinary editor Undo wins over
group Undo. Search text persists only through an explicit named-filter save;
in-session drill-in keeps it without storing it across relaunch.

## Verification

Coherent targeted milestones; disposable timezone/DST/legacy, mutation/generation,
cancellation, undo/stale-intent and backup/restore fixtures. Synthetic long-
transcript before/after measurements must exceed noise. Keyboard-only, focus,
busy/nested Escape, width/zoom/dark-mode and large Library/Weekly UI fixtures.
Full existing clean-Mac local CI before completion; reuse unchanged evidence and
keep remote gates. Capture/export/backup tests never touch real user data.

## Progress

Implementation slices complete. Targeted data/recording/search tests and
synthetic keyboard/dialog/transcript/Weekly task fixtures pass. Full clean-Mac
verification and publication remain pending; see the verification record.
