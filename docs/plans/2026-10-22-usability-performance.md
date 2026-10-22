# MeetingNotes 1.19: approved usability and performance improvements

User authorized all twelve recommendations, PR, merge, release and local installer.
Preserve original audio, immutable weekly reports, existing profiles, and unrelated work.

## Acceptance checklist

- [x] 1. Merge/dedupe preserves native profiles, with recoverable originals.
- [x] 2. Speaker review explains automatic matching decisions.
- [x] 3. Compact searchable voiceprint manager with provenance and undo.
- [x] 4. Cached/batched speaker review with correct invalidation.
- [x] 5. Content search only scans eligible meeting folders.
- [x] 6. Independent speech-stage progress and scoped cancellation.
- [x] 7. Memory-aware long-meeting speech scheduling; synthetic measurement.
- [x] 8. Friendly filter labels and keyboard-accessible results/status.
- [x] 9. Persistent pinned groups after Ungrouped.
- [x] 10. Live cross-meeting actions, owner/group/due filters, source links.
- [x] 11. Group preparation from saved notes and open tasks with source links.
- [x] 12. Optional notes-first workflow, safe later speaker resolution.

## Verification and shipment

Use targeted checks after coherent slices and one final local CI suite. Exercise new
screens with disposable fixtures. Document performance measurements and limitations.
Bump to 1.19.0, update README/release notes, push PR and merge after verification.
Publish a source-only GitHub release and build/verify a local arm64 installer. Do not
install or interrupt the running app. No installer VM test requested.
