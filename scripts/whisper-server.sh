#!/usr/bin/env bash
# Manage a local whisper.cpp server for MeetingNotes STT.
#
# Usage:
#   scripts/whisper-server.sh install [model]     download a GGML model (default: medium.en)
#   scripts/whisper-server.sh start   [model]     start whisper-server in the foreground
#   scripts/whisper-server.sh daemon  [model]     start in background, write PID file
#   scripts/whisper-server.sh stop                stop the daemon
#   scripts/whisper-server.sh status              show daemon status
#   scripts/whisper-server.sh models              list installed models
#
# Environment overrides:
#   WHISPER_MODELS_DIR  default: ~/Library/Application Support/MeetingNotes/whisper-models
#   WHISPER_HOST        default: 127.0.0.1
#   WHISPER_PORT        default: 8080

set -euo pipefail

MODELS_DIR="${WHISPER_MODELS_DIR:-$HOME/Library/Application Support/MeetingNotes/whisper-models}"
HOST="${WHISPER_HOST:-127.0.0.1}"
PORT="${WHISPER_PORT:-8080}"
LOG_DIR="$HOME/Library/Logs/MeetingNotes"
PID_FILE="$LOG_DIR/whisper-server.pid"
LOG_FILE="$LOG_DIR/whisper-server.log"
DEFAULT_MODEL="medium.en"

mkdir -p "$MODELS_DIR" "$LOG_DIR"

require_whisper_cpp() {
  if ! command -v whisper-server >/dev/null && ! command -v whisper-cpp >/dev/null; then
    echo "ERROR: whisper.cpp not installed. Install with:" >&2
    echo "  brew install whisper-cpp" >&2
    exit 1
  fi
}

# Locate the brew download script regardless of brew prefix (Apple Silicon vs Intel).
download_script_path() {
  local prefix
  prefix="$(brew --prefix whisper-cpp 2>/dev/null || true)"
  if [ -n "$prefix" ] && [ -f "$prefix/share/whisper-cpp/download-ggml-model.sh" ]; then
    echo "$prefix/share/whisper-cpp/download-ggml-model.sh"
    return 0
  fi
  return 1
}

model_file() {
  echo "$MODELS_DIR/ggml-$1.bin"
}

# name|size|description — shown in interactive picker.
MODEL_CHOICES=(
  "tiny.en|75 MB|fastest, English-only, lowest accuracy"
  "base.en|142 MB|fast, English-only, decent for clean audio"
  "small.en|466 MB|good balance for English meetings"
  "medium.en|1.5 GB|recommended for English meetings"
  "medium|1.5 GB|multilingual medium"
  "large-v3|2.9 GB|best accuracy, slower (Metal-accelerated on Apple Silicon)"
  "large-v3-turbo|1.5 GB|near large-v3 accuracy, much faster"
)

pick_model_interactive() {
  echo "Select a Whisper model:" >&2
  local i=1
  for entry in "${MODEL_CHOICES[@]}"; do
    local name size desc
    IFS='|' read -r name size desc <<<"$entry"
    printf "  %d) %-16s %-8s %s\n" "$i" "$name" "$size" "$desc" >&2
    i=$((i + 1))
  done
  printf "Choice [1-%d, default %s]: " "${#MODEL_CHOICES[@]}" "$DEFAULT_MODEL" >&2
  local choice
  read -r choice </dev/tty || true
  if [ -z "$choice" ]; then
    echo "$DEFAULT_MODEL"
    return
  fi
  if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "${#MODEL_CHOICES[@]}" ]; then
    echo "Invalid choice." >&2
    exit 1
  fi
  local entry="${MODEL_CHOICES[$((choice - 1))]}"
  echo "${entry%%|*}"
}

cmd_install() {
  require_whisper_cpp
  local model
  if [ "$#" -ge 1 ] && [ -n "$1" ]; then
    model="$1"
  else
    model="$(pick_model_interactive)"
  fi
  local file
  file="$(model_file "$model")"
  if [ -f "$file" ]; then
    echo "Already installed: $file"
    return 0
  fi
  local script
  if script="$(download_script_path)"; then
    echo "Downloading $model into $MODELS_DIR ..."
    ( cd "$MODELS_DIR" && bash "$script" "$model" )
  else
    # Fallback: direct download from Hugging Face mirror.
    echo "brew download script not found; pulling from Hugging Face ..."
    local url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$model.bin"
    curl -fL --progress-bar -o "$file" "$url"
  fi
  echo "Installed: $file"
}

cmd_models() {
  ls -lh "$MODELS_DIR" 2>/dev/null | awk 'NR>1 {print $9, $5}' | column -t || true
}

# Pick the best installed model when no name was passed. Preference order
# below favors English meeting accuracy with reasonable speed.
auto_pick_model() {
  local prefs=(medium.en medium small.en small large-v3-turbo large-v3 base.en base tiny.en tiny)
  for p in "${prefs[@]}"; do
    if [ -f "$(model_file "$p")" ]; then
      echo "$p"
      return 0
    fi
  done
  # Fall back to whatever ggml-*.bin exists.
  local first
  first=$(ls "$MODELS_DIR"/ggml-*.bin 2>/dev/null | head -1 || true)
  if [ -n "$first" ]; then
    basename "$first" | sed -n 's/^ggml-\(.*\)\.bin$/\1/p'
    return 0
  fi
  return 1
}

resolve_model_or_die() {
  local model="${1:-}"
  if [ -z "$model" ]; then
    if ! model="$(auto_pick_model)"; then
      echo "No Whisper model installed under $MODELS_DIR" >&2
      echo "Install one:  $0 install" >&2
      exit 1
    fi
    echo "(auto-picked model: $model)" >&2
  fi
  local file
  file="$(model_file "$model")"
  if [ ! -f "$file" ]; then
    echo "Model not found: $file" >&2
    echo "Install it:  $0 install $model" >&2
    exit 1
  fi
  echo "$model"
}

resolve_binary() {
  if command -v whisper-server >/dev/null; then
    echo "whisper-server"
  else
    # Older builds ship only `whisper-cpp` which can run server mode via `--server` on some forks.
    echo "ERROR: whisper-server binary not found. Update whisper-cpp:" >&2
    echo "  brew upgrade whisper-cpp" >&2
    exit 1
  fi
}

cmd_start() {
  require_whisper_cpp
  local model
  model="$(resolve_model_or_die "${1:-}")"
  local file
  file="$(model_file "$model")"
  local bin
  bin="$(resolve_binary)"
  echo "Starting whisper-server on $HOST:$PORT with $model"
  exec "$bin" --model "$file" --host "$HOST" --port "$PORT"
}

cmd_daemon() {
  require_whisper_cpp
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Already running (pid $(cat "$PID_FILE")). Use 'stop' first."
    exit 0
  fi
  local model
  model="$(resolve_model_or_die "${1:-}")"
  local file
  file="$(model_file "$model")"
  local bin
  bin="$(resolve_binary)"
  echo "Starting whisper-server in background on $HOST:$PORT (model: $model)"
  nohup "$bin" --model "$file" --host "$HOST" --port "$PORT" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 1
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Started (pid $(cat "$PID_FILE")). Logs: $LOG_FILE"
  else
    echo "Failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
}

cmd_stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "Not running (no pid file)."
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "Stopped (pid $pid)."
  else
    echo "Stale pid file (pid $pid not running)."
  fi
  rm -f "$PID_FILE"
}

cmd_status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Running (pid $(cat "$PID_FILE")) on $HOST:$PORT"
    if command -v curl >/dev/null; then
      curl -fsS "http://$HOST:$PORT/v1/models" >/dev/null && echo "Health: ok" || echo "Health: unreachable"
    fi
  else
    echo "Not running"
  fi
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  start)   shift; cmd_start "$@" ;;
  daemon)  shift; cmd_daemon "$@" ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  models)  cmd_models ;;
  *)
    grep -E '^# ' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
