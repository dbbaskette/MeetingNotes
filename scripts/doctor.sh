#!/usr/bin/env bash
# Read-only native speech/media/summary checks. Never starts a server or download.
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/doctor-config.sh
failures=0
for tool in ffmpeg ffprobe; do
  if command -v "$tool" >/dev/null; then printf 'OK %s\n' "$tool"; else printf 'Missing %s: brew install ffmpeg\n' "$tool"; failures=$((failures+1)); fi
done
if [[ "$(uname -m)" != arm64 || "$(sw_vers -productVersion | cut -d. -f1)" -lt 26 ]]; then
  echo 'Unsupported: Apple silicon and macOS 26+ required'; failures=$((failures+1))
fi
if [[ -x speech-engine/.build/release/meeting-notes-speech || -x /Applications/MeetingNotes.app/Contents/Resources/bin/meeting-notes-speech ]]; then
  echo 'OK native speech helper found. Check Apple language and SpeakerKit readiness in Settings → Processing.'
else echo 'Native speech helper missing: build with ./scripts/setup.sh or reinstall the app'; failures=$((failures+1)); fi
[[ -d "$LIB" ]] && printf 'Library: %s\n' "$LIB" || echo 'Library will be created on first launch'
if curl -fsS --max-time 3 "$LLM_URL/v1/models" >/dev/null; then echo "OK summary endpoint ($PROVIDER)";
else echo "Summary endpoint is not responding ($PROVIDER); configure it in Settings. Managed runtimes may be idle."; fi
[[ "$failures" == 0 ]]
