#!/usr/bin/env bash
# Builds the meeting-notes-tap helper as a release binary at
# audio-tap/build/meeting-notes-tap. Stamps a BUILD_ID file so the
# Electron main process can verify which binary it spawned.
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release \
  -Xswiftc -target -Xswiftc arm64-apple-macos14.2

mkdir -p build
cp .build/release/meeting-notes-tap build/meeting-notes-tap
date -u +"%Y%m%dT%H%M%SZ-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)" > BUILD_ID

echo "Built audio-tap/build/meeting-notes-tap"
echo "BUILD_ID: $(cat BUILD_ID)"
