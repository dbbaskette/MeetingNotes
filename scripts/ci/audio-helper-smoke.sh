#!/usr/bin/env bash
set -euo pipefail
task_native_root="${1:?Pass the disposable native build directory for this run}"
mkdir -p "$task_native_root"
swift build --jobs 2 --package-path audio-tap --scratch-path "$task_native_root/build"
# Command Line Tools include Swift/AVFoundation but not XCTest. Compile the
# same assertions used by the developer XCTest target without that framework.
swiftc -parse-as-library -target arm64-apple-macos14.2 \
  audio-tap/Sources/meeting-notes-tap/AACWriter.swift \
  audio-tap/Sources/meeting-notes-tap/StatusEvents.swift \
  audio-tap/Tests/meeting-notes-tap-tests/AACWriterSmoke.swift \
  scripts/ci/audio-helper-smoke.swift -o "$task_native_root/writer-smoke"
"$task_native_root/writer-smoke"
