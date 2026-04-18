#!/usr/bin/env bash
# One-shot launcher for MeetingNotes.
# Default mode: start whisper-server in the background, then open the packaged .app.
#
# Usage:
#   scripts/start.sh             # production: whisper-server + open .app
#   scripts/start.sh --dev       # development: whisper-server + 'npm run dev'
#   scripts/start.sh --stop      # stop background services started by this script
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
    # 1. Whisper server (background daemon, idempotent).
    if "$WS" status 2>&1 | grep -q "Running"; then
      echo "whisper-server: already running"
    else
      "$WS" daemon
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
  APP="release/mac-arm64/MeetingNotes.app"
  if [ ! -d "$APP" ]; then
    echo
    echo "Packaged app not found at $APP."
    echo "Build it first:  npm run dist"
    echo "Or run dev mode: $0 --dev"
    exit 1
  fi
  echo
  echo "Opening $APP ..."
  open "$APP"
fi
