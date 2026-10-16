#!/usr/bin/env bash
# Native-only source setup. Configure speech assets and summaries in the app.
# --skip-npm: keep installed Node dependencies. --native/--skip-dist are
# accepted aliases for older instructions; this setup never builds Python.
set -euo pipefail
cd "$(dirname "$0")/.."
skip_npm=0
for arg in "$@"; do
  case "$arg" in
    --skip-npm) skip_npm=1 ;;
    --native|--skip-dist|--skip-llm) ;;
    --help|-h) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 || "$(sw_vers -productVersion | cut -d. -f1)" -lt 26 ]]; then
  echo 'MeetingNotes requires Apple silicon and macOS 26 or newer.' >&2; exit 1
fi
for tool in node npm swift ffmpeg ffprobe; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Install Node, Xcode 26+ and FFmpeg before building." >&2; exit 1; }
done
if [[ "$skip_npm" == 0 ]]; then npm ci; fi
npm run build:audio-tap
npm run build:speech
npm run build
printf '%s\n' 'Ready. Run npm start, then Prepare native speech in Settings → Processing.'
printf '%s\n' 'Configure your summary model in the app. No transcription server or account token is required.'
printf '%s\n' 'Build a local installer separately with npm run dist. Existing meetings and model caches were not changed.'
