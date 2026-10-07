# Local macOS verification

Run `bash scripts/ci/tart-macos.sh --dry-run` to inspect the shared Tart plan,
then `bash scripts/ci/tart-macos.sh`. This uses the existing macos-test-suite
runner and a stopped Golden Gate base. It owns only its disposable clone,
stops/deletes it on exit, and retains host logs.

Commit the intended source before a full run. The guest copies only Git-tracked
files into disposable storage; unrelated untracked files, local credentials,
node_modules, and the user's installed app/library are not used. Its log records
the source commit/tree, dirty status, actual OS, Node, npm, and Electron versions.

For a fixture-only follow-up after an unchanged product source has passed the
full suite, `bash scripts/ci/tart-macos.sh --renderer-only` installs fresh
dependencies and reruns selection/grouped/Settings/history fixtures. Its log
explicitly records renderer-only coverage; it is not a replacement for full CI.

Coverage: clean dependency installation, Node-native rebuild, Swift audio-helper build and synthetic writer tests, full Vitest suite,
renderer type checks, production build, scoped changed-file lint, synthetic Browse
benchmark against the reviewed baseline, Electron-native rebuild, and isolated
Library/Settings/history renderer fixtures. All UI/API data is synthetic; no
microphone, real account, vault, or paid service is contacted.

The populated Library startup regression renders the real Library with 600
meetings, three expanded groups, and 113 recovery entries. It checks subpixel
geometry jitter, narrow/short flex layouts, zoom, view switching, and collapse,
and fails on renderer/React errors. An empty first-run permissions screen is
not evidence that a populated Library renders successfully.

The guest writes PASS only after all checks finish. Results are retained under
`~/Library/Logs/MacOS Test Suite/meetingnotes/`. Required GitHub gates still apply.

The audio-helper gate builds the complete Swift helper and runs synthetic AAC
writer checks without microphone or process-tap access. Its framework-free
harness shares the exact assertions used by the developer XCTest target, since
the Command Line Tools-only clean VM does not include XCTest.

The shared assertions now cover bounded shared-clock mic/system mixing, startup
silence, gaps/resumption and decoded tone plus offline TTS speech levels, gain,
clipping and duration alignment. They do not capture a microphone.

For an explicitly requested packaged-runtime gate, build a disposable unsigned
package and run `node scripts/ci/prepare-package-fixture.mjs /absolute/path/MeetingNotes.app /absolute/path/synthetic-speech.wav`.
This creates the ignored `.ci-package-fixture/` payload with the current source
commit. Only four required cached pyannote model directories are copied as regular
files (including pyannote 4's small PLDA dependency, not new account downloads);
credentials and user meetings are never copied. The guest rejects stale commit
metadata. Do not put a release installer or real audio in this payload.

With the payload present, the normal full runner additionally exercises the
actual packaged main/preload/renderer using a marked, temporary 600-meeting
library, normal and SwiftShader startup, helper enumeration without capture,
configured STT/summary transport with synthetic loopback responses, and actual
offline sidecar diarization of TTS speech. No real LLM/STT inference or signed-in
export is claimed by the transport fixture. Packaged runs never register the
global URL handler or touch the installed app's data. Results include screenshots
and sidecar logs; the temporary app/profile are removed after testing.
