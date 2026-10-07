#!/usr/bin/env bash
set -euo pipefail
task_native_root="${1:?Pass the disposable native build directory for this run}"
mkdir -p "$task_native_root"
swift build --jobs 2 --package-path audio-tap --scratch-path "$task_native_root/build"
# Command Line Tools include Swift/AVFoundation but not XCTest. Compile the
# same assertions used by the developer XCTest target without that framework.
swiftc -parse-as-library -target arm64-apple-macos14.2 \
  audio-tap/Sources/meeting-notes-tap/AACWriter.swift \
  audio-tap/Sources/meeting-notes-tap/CaptureTimeline.swift \
  audio-tap/Sources/meeting-notes-tap/StatusEvents.swift \
  audio-tap/Tests/meeting-notes-tap-tests/AACWriterSmoke.swift \
  audio-tap/Tests/meeting-notes-tap-tests/CaptureTimelineSmoke.swift \
  scripts/ci/audio-helper-smoke.swift -o "$task_native_root/writer-smoke"
# Offline TTS fixture: no microphone, user speech or meeting content.
/usr/bin/say -o "$task_native_root/speech.aiff" 'This is a synthetic meeting test. We will review the project milestones, name the speakers, and preserve the action items. The next meeting is scheduled for Friday. Please check the recording timeline and audio quality.'
/usr/bin/afconvert -f WAVE -d LEF32@48000 -c 1 "$task_native_root/speech.aiff" "$task_native_root/speech.wav"
MN_AUDIO_SPEECH_FIXTURE="$task_native_root/speech.wav" "$task_native_root/writer-smoke"
