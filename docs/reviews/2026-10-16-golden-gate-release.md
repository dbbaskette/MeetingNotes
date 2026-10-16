# Golden Gate 1.17.0 verification

Scope: approved visual design across the existing Electron app and a portable,
locally installed stack-neutral Golden Gate skill. No data/schema/processing
changes, installed-app replacement, active capture or real service calls.

## Evidence record

Targeted evidence: all 42 appearance-token contrast tests pass, main renderer
and fixture type checks pass, production build and whole-repository lint pass.
The isolated appearance fixture passes on the host with synthetic data across
five screens, two themes and two sizes, plus dialog/source-picker interaction
and emulated reduced effects/focus styles. Screenshots were inspected.

The portable and installed skill pass the official validator, YAML discovery
and local-reference checks; the two copies match exactly. Manual routing review
covers a web restyle, native restyle, review-only request and unrelated request:
the skill preserves stack/scope and does not authorize publication by itself.

## Source and local artifacts

Product source: `a3597f8b91641f6ad0399ce91d11176dc45e7792`, tree
`bfdd411806587b7b1d03ba9bf2a8ebd79afb8170`. Subsequent documentation/screenshot
evidence updates do not alter product code or dependencies.

Host: macOS 27.0.1 (26A434), Apple silicon, Node 22.23.1, Electron 44.7.0.
Both Swift helpers and the final production renderer were built before packaging.
The real built source app rendered a synthetic 600-meeting Library with 50
loaded rows and a next page, without warning/error logs or CSP violations.

`release/v1.17.0/` artifacts pass deep/strict code-signature verification,
app/ASAR version 1.17.0, minimum macOS 26.0.0, DMG checksum and ZIP integrity.
All **175 generated runtime files** byte-match the signed ASAR payload. Capture
and native-speech helpers are present; compiled legacy speech modules are absent.
Signing is Apple Development; notarization was explicitly skipped by the builder.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| MeetingNotes-1.17.0-arm64.dmg | 120,602,654 | `0d25297632b050027b22edf46e6457d3533af018ae26e79bf1afef421e47e3ca` |
| MeetingNotes-1.17.0-arm64-mac.zip | 129,560,093 | `43c3cdcf785410f1939025bb06fe103bd51f6b78a3d5f3ec6feaab5057a482b3` |

Existing 1.16.0 and 1.15.0 installers remain for rollback. The task-owned loose
1.17 app is removed after verification to avoid LaunchServices duplicates;
the DMG/ZIP retain the signed bundle. Nothing is installed or restarted.

## Full local CI

Initial run `meetingnotes-test-20261016212015-60407-71c200ef` passed all 1,362
tests and the complete capture-helper harness, then caught strict indexed-access
typing in the new contrast-test helper. A test-only follow-up uses RGB tuples
and explicit missing-token checks. Both renderer/fixture type checks, all 42
contrast tests, lint and docs then passed locally. No product source changed.
The failed clone was deleted; logs remain under the standard MeetingNotes
results directory.

The next run `meetingnotes-test-20261016212535-65991-6621d455` hit the previously
documented unchanged `LibraryWatcher` five-second timeout (1,361 tests passed).
The isolated watcher suite passed 10/10 in 2.08 seconds on the host; its product
and test files have no diff from main. This supports intermittency, not a proven
root cause. No watcher behavior, assertions, timeouts or CI gate were changed.
That clone was also deleted.

**Final full run: PASS**, `meetingnotes-test-20261016212835-67705-bf9ca7ee`.
Tested commit `19f2b124b4570a1dee62e42e6d4a8fa70cd8e6b5`, tree
`b07abe7f02ef2b55a7d3e9de9de2a85735353798`. Actual guest: macOS 27.0 (26A428),
arm64, Node 22.23.2, npm 10.9.8, Electron 44.7.0.

- Clean dependency installation/Electron-native rebuild; **1,362 tests passed,
  six skipped**, 158 test files passed/two skipped.
- Complete capture-helper synthetic writer/microphone-timing harness.
- Renderer, fixture and main type checks, production build, docs and repository
  zero-warning lint.
- Browse benchmark; all **12 UI fixture modes**, including appearance,
  populated Library/scroll/zoom, processing, naming, selection/group moves,
  terminology, Settings/history and rename navigation; beta comparison UI.
- Runner wrote PASS, exited zero, deleted its owned clone and posted
  `tart-ci=success`. No task-owned VM remains. Base and unrelated VMs were not
  changed. No installer payload was staged or installer VM acceptance run.

Logs/screenshots remain at
`~/Library/Logs/MacOS Test Suite/meetingnotes/<run-name>/` for all three runs.
Final documentation/screenshot-only updates reuse this unchanged tested product
and test tree; docs/link checks run separately before merge. The installer
product remains byte-identical to the tested app source.

## Acceptance boundaries

- Isolated renderer checks use synthetic data, not the installed app or library.
- CSS material is not native OS glass; opaque/reduced-effects behavior is tested.
- Existing virtualization and scroll owners are preserved.
- No installer VM acceptance, actual capture or inference is requested/claimed.
- Dependency versions are unchanged; npm reports the existing 38 audit findings
  (one low, 12 moderate, 22 high, three critical). No automatic dependency upgrade
  or audit remediation is claimed in this visual release.
