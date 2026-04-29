#!/usr/bin/env bash
# One-shot launcher for MeetingNotes.
#
# Since the lazy-managed-services change, MeetingNotes spawns
# whisper-server itself on demand (first transcription wakes it,
# 10 minutes of idle time shuts it down). This script no longer
# auto-starts the whisper daemon. It still:
#   - kills any stale MeetingNotes process so we relaunch into the
#     fresh build instead of focusing the old window
#   - frees ports 8080/8765 in case a detached child outlived its parent
#   - launches LM Studio if installed but not running
#   - opens the .app (or runs `npm run dev`)
#
# Usage:
#   scripts/start.sh             # production: open .app
#   scripts/start.sh --dev       # development: 'npm run dev'
#   scripts/start.sh --stop      # stop any whisper-server daemon left over from a prior install
#   scripts/start.sh --status    # show what's running

set -euo pipefail
cd "$(dirname "$0")/.."

MODE="prod"
case "${1:-}" in
  --dev)    MODE="dev" ;;
  --stop)   MODE="stop" ;;
  --status) MODE="status" ;;
  -h|--help)
    sed -n '2,11p' "$0"
    exit 0 ;;
  "") ;;
  *) echo "Unknown flag: $1" >&2; exit 1 ;;
esac

LOG_DIR="$HOME/Library/Logs/MeetingNotes"
mkdir -p "$LOG_DIR"

# Make the saved HF token available to anything we spawn that doesn't read the
# cache file (older HF clients only check env). The diarization sidecar uses
# the cache file directly, so this is belt-and-suspenders.
HF_TOKEN_FILE="$HOME/.cache/huggingface/token"
if [ -s "$HF_TOKEN_FILE" ] && [ -z "${HF_TOKEN:-}" ]; then
  export HF_TOKEN
  HF_TOKEN="$(cat "$HF_TOKEN_FILE")"
fi

WS="./scripts/whisper-server.sh"

case "$MODE" in
  status)
    "$WS" status
    exit 0 ;;

  stop)
    echo "Stopping whisper-server..."
    "$WS" stop || true
    echo "(LM Studio and the .app are managed by you — close them manually.)"
    exit 0 ;;

  prod|dev)
    # 0. Kill any previously-running MeetingNotes instance so we relaunch into
    #    the fresh build, not an old Electron/sidecar pair still in memory.
    #    macOS's `open` would otherwise just focus the existing process.
    if pgrep -f "MeetingNotes.app/Contents/MacOS/MeetingNotes" >/dev/null 2>&1; then
      echo "MeetingNotes:   killing running instance to pick up the fresh build..."
      pkill -f "MeetingNotes.app/Contents/MacOS/MeetingNotes" >/dev/null 2>&1 || true
      # Give Electron a beat to unwind its child processes.
      sleep 1
    fi
    # Free the sidecar port in case a detached sidecar survived the kill.
    # The supervisor's build_id check would eventually catch this, but killing
    # here means one fewer race during cold start.
    if lsof -ti :8765 >/dev/null 2>&1; then
      echo "sidecar:        killing process holding port 8765..."
      lsof -ti :8765 | xargs kill -9 2>/dev/null || true
    fi

    # 1. Whisper server: MeetingNotes spawns it lazily on first
    #    transcription. We don't pre-launch it here — the supervisor
    #    in the app handles spawn + idle shutdown. If a user started
    #    whisper-server.sh daemon manually, the supervisor adopts it.
    if "$WS" status 2>&1 | grep -q "Running"; then
      echo "whisper-server: already running (will be adopted by the app)"
    else
      echo "whisper-server: not running — app will start it on first transcribe"
    fi

    # 2. LM Studio: auto-launch if installed but not reachable, then wait for it.
    LM_URL="${LM_STUDIO_URL:-http://localhost:1234}"
    if curl -fsS --max-time 2 "$LM_URL/v1/models" >/dev/null 2>&1; then
      echo "LM Studio:      reachable at $LM_URL"
    else
      if [ -d "/Applications/LM Studio.app" ]; then
        echo "LM Studio:      not running — launching..."
        open -a "LM Studio"
        # Wait up to 30s for the local server to come up (user must have enabled it
        # in LM Studio's settings; we can't toggle that headlessly).
        for i in $(seq 1 30); do
          if curl -fsS --max-time 1 "$LM_URL/v1/models" >/dev/null 2>&1; then
            echo "LM Studio:      reachable at $LM_URL (after ${i}s)"
            break
          fi
          sleep 1
        done
        if ! curl -fsS --max-time 1 "$LM_URL/v1/models" >/dev/null 2>&1; then
          echo "LM Studio:      launched but server not reachable yet"
          echo "                Make sure 'Local Server' is enabled in LM Studio and a model is loaded."
        fi
      else
        echo "LM Studio:      NOT installed at /Applications/LM Studio.app"
        echo "                Download from https://lmstudio.ai — summarization will fail without it."
      fi
    fi

    # 3. HF token check (non-fatal).
    if [ -s "$HF_TOKEN_FILE" ]; then
      echo "HF token:       saved at $HF_TOKEN_FILE"
    else
      echo "HF token:       NOT set — diarization will fail on first model download."
      echo "                Run: ./scripts/setup.sh --skip-npm --skip-sidecar --skip-whisper --skip-llm --skip-dist"
    fi
    ;;
esac

# 4. Launch the app.
if [ "$MODE" = "dev" ]; then
  echo
  echo "Starting dev mode (Vite + Electron, hot reload)..."
  exec npm run dev
else
  # Prefer the dmg-installed copy in /Applications. The loose
  # release/mac-arm64/MeetingNotes.app used to live here too, but
  # `npm run dist` now cleans it up — it was getting registered
  # with LaunchServices and showing up as a Launchpad duplicate.
  if [ -d "/Applications/MeetingNotes.app" ]; then
    APP="/Applications/MeetingNotes.app"
  else
    APP="release/mac-arm64/MeetingNotes.app"
  fi
  if [ ! -d "$APP" ]; then
    echo
    echo "MeetingNotes.app not found in /Applications. Build + install:"
    echo "  npm run dist"
    echo "  open release/MeetingNotes-0.1.0-arm64.dmg   # then drag to /Applications"
    exit 1
  fi
  echo
  echo "Opening $APP ..."
  open "$APP"
fi
