# Unified meeting terminology — approved implementation

The owner approved the proposed workflow and authorized implementation, a patch
version increment, push/PR/merge, source release and local installer build.

Contract: define a replacement once from either document; preview labeled
occurrences and separate counts; apply selected matches to both in one operation;
offer explicit remembering with existing scope/mode; provide grouped Undo.
Do not regenerate notes/actions, touch audio/raw transcription, rewrite other
meetings or discard unsaved edits. Preserve existing per-document APIs/history.

Implementation uses the shared matcher and dictionary with a meeting scope,
combined revision checks, prefixed occurrence IDs and batch-tagged history.
The existing SQLite document journal records all writes in one transaction;
file replacement either completes or rolls back with recoverable intention.
Conflicting external edits are never overwritten. No schema changes.

Verification: targeted service/IPC/matcher tests, actual correction-panel fixture,
full repository source CI, production/type/lint checks, then package identity,
signature and archive-integrity checks. Installer VM testing is omitted per the
owner's prior instruction. Real recording/account/vault checks remain deferred.

Completed source verification: commit `95351be3b029daa9cbec1ca87be4a54690085cd2`,
tree `25f3472bf8d158b9009fcd084393e9fe9c118286`, full shared Tart source runner
PASS on macOS 27.0 / Node 22.23.2 / Electron 30.5.1. Unit suite: 1,225 passed,
six skipped. All nine renderer modes, Swift synthetic checks, types, build,
scoped lint and Browse benchmark passed. The VM was removed; retained logs are
in the task-owned `.ci-epic243-results/unified-terminology/tart/` directory.
An earlier worktree-mounted attempt stopped before tests because its Git
metadata was not mounted; a self-contained temporary clone resolved that.
