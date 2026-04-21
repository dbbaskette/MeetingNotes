#!/usr/bin/env bash
# Builds the meeting-notes-tap helper as a release binary at
# audio-tap/build/meeting-notes-tap. Stamps a BUILD_ID file so the
# Electron main process can verify which binary it spawned.
#
# Task 12: embeds Info.plist into the Mach-O __TEXT,__info_plist section
# and codesigns with audio-input entitlements so macOS TCC can show the
# helper in System Settings → Privacy → Screen & System Audio Recording
# / Microphone, and so the Process Tap actually delivers audio data.
set -euo pipefail
cd "$(dirname "$0")/.."

INFO_PLIST="$(pwd)/Info.plist"
ENTITLEMENTS="$(pwd)/entitlements.plist"
SRC_DIR="$(pwd)/Sources/meeting-notes-tap"
OUT_DIR="$(pwd)/build"
OUT_BIN="$OUT_DIR/meeting-notes-tap"

mkdir -p "$OUT_DIR"

# Compile all .swift sources directly with swiftc so we can pass linker
# flags to embed the Info.plist into the binary. swift-package-manager
# does not give us a clean way to add -sectcreate.
SWIFT_FILES=("$SRC_DIR"/*.swift)

echo "Compiling ${#SWIFT_FILES[@]} swift files -> $OUT_BIN"
xcrun swiftc \
  -target arm64-apple-macos14.2 \
  -O \
  -framework AVFoundation \
  -framework AudioToolbox \
  -framework CoreAudio \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$INFO_PLIST" \
  -o "$OUT_BIN" \
  "${SWIFT_FILES[@]}"

# Codesign with entitlements. Prefer a real Apple Development identity
# if available so TCC gets a stable designated requirement; otherwise
# fall back to ad-hoc signing.
if [[ -n "${CODESIGN_IDENTITY:-}" ]]; then
  IDENTITY="$CODESIGN_IDENTITY"
else
  IDENTITY="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'"' '/Apple Development|Developer ID Application/ {print $2; exit}')"
  if [[ -z "$IDENTITY" ]]; then
    IDENTITY="-"
    echo "No codesign identity found; using ad-hoc signature."
  else
    echo "Using codesign identity: $IDENTITY"
  fi
fi

codesign --force \
  --options runtime \
  --timestamp=none \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$OUT_BIN"

# Stamp build id
date -u +"%Y%m%dT%H%M%SZ-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)" > BUILD_ID

echo "Built $OUT_BIN"
echo "BUILD_ID: $(cat BUILD_ID)"
echo
echo "--- codesign entitlements ---"
codesign -d --entitlements - "$OUT_BIN" 2>&1 || true
echo
echo "--- embedded Info.plist (otool -P) ---"
otool -P "$OUT_BIN" 2>&1 | head -40 || true
