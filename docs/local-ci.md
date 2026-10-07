# Local macOS verification

Run `bash scripts/ci/tart-macos.sh --dry-run` to inspect the shared Tart plan,
then `bash scripts/ci/tart-macos.sh`. This uses the existing macos-test-suite
runner and a stopped Golden Gate base. It owns only its disposable clone,
stops/deletes it on exit, and retains host logs.

Commit the intended source before a full run. The guest copies only Git-tracked
files into disposable storage; unrelated untracked files, local credentials,
node_modules, and the user's installed app/library are not used. Its log records
the source commit/tree, dirty status, actual OS, Node, npm, and Electron versions.

Coverage: clean dependency installation, Node-native rebuild, full Vitest suite,
renderer type checks, production build, scoped changed-file lint, synthetic Browse
benchmark against the reviewed baseline, Electron-native rebuild, and isolated
Library/Settings/history renderer fixtures. All UI/API data is synthetic; no
microphone, real account, vault, or paid service is contacted.

The guest writes PASS only after all checks finish. Results are retained under
`~/Library/Logs/MacOS Test Suite/meetingnotes/`. Required GitHub gates still apply.
