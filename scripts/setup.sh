#!/usr/bin/env bash
# MeetingNotes setup. Idempotent — safe to re-run any time. Re-running is the
# supported way to change Whisper models or repair a partial install.
#
# Flags:
#   --skip-npm      don't run `npm install`
#   --skip-sidecar  don't (re)create the Python sidecar venv
#   --skip-whisper  don't prompt for a Whisper model
#   --skip-hf       don't prompt for a Hugging Face token (pyannote model download)
#   --skip-llm      don't prompt for the LM Studio chat model / STT URL
#   --skip-dist     don't build the production .app
#   --model NAME    install/select this Whisper model non-interactively

set -euo pipefail

SKIP_NPM=0
SKIP_SIDECAR=0
SKIP_WHISPER=0
SKIP_HF=0
SKIP_LLM=0
SKIP_DIST=0
MODEL_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-npm)     SKIP_NPM=1 ;;
    --skip-sidecar) SKIP_SIDECAR=1 ;;
    --skip-whisper) SKIP_WHISPER=1 ;;
    --skip-hf)      SKIP_HF=1 ;;
    --skip-llm)     SKIP_LLM=1 ;;
    --skip-dist)    SKIP_DIST=1 ;;
    --model)        MODEL_ARG="${2:-}"; shift ;;
    -h|--help)
      sed -n '2,13p' "$0"
      exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }

bold "MeetingNotes setup"
echo "  Root: $ROOT"

# ---------------------------------------------------------------------------
bold "1. Prerequisites"
missing=0
need() {
  if command -v "$1" >/dev/null; then ok "$1"
  else echo "  \033[31m✗\033[0m $1 — install: $2"; missing=1
  fi
}
need node          "https://nodejs.org or 'brew install node'"
need npm           "ships with Node"
need python3       "https://www.python.org or 'brew install python'"
need ffmpeg        "brew install ffmpeg"
need ffprobe       "brew install ffmpeg"
need whisper-server "brew install whisper-cpp"
[ "$missing" -eq 1 ] && { echo; echo "Install missing tools and re-run."; exit 1; }

# ---------------------------------------------------------------------------
if [ "$SKIP_NPM" -eq 0 ]; then
  bold "2. Node dependencies"
  npm install
else
  bold "2. Node dependencies (skipped)"
fi

# ---------------------------------------------------------------------------
if [ "$SKIP_SIDECAR" -eq 0 ]; then
  bold "3. Python sidecar (pyannote diarization)"
  if [ -x "sidecar/.venv/bin/python" ]; then
    ok "venv exists at sidecar/.venv (re-running install to refresh deps)"
  fi
  ( cd sidecar && ./scripts/install.sh )
else
  bold "3. Python sidecar (skipped)"
fi

# ---------------------------------------------------------------------------
bold "4. Library directories"
LIB="${MEETINGNOTES_LIB:-$HOME/Documents/MeetingNotes}"
mkdir -p "$LIB"/meetings "$LIB"/speakers/embeddings
ok "$LIB"

# ---------------------------------------------------------------------------
if [ "$SKIP_WHISPER" -eq 0 ]; then
  bold "5. Whisper model"
  WS="$ROOT/scripts/whisper-server.sh"
  installed_models=$("$WS" models 2>/dev/null | awk '{print $1}' | sed -n 's/^ggml-\(.*\)\.bin$/\1/p' | tr '\n' ' ')
  if [ -n "$installed_models" ]; then
    ok "already installed: $installed_models"
    echo
    if [ -n "$MODEL_ARG" ]; then
      "$WS" install "$MODEL_ARG"
    else
      printf "  Install another / different model? [y/N]: "
      read -r ans </dev/tty || ans=""
      if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
        "$WS" install
      fi
    fi
  else
    if [ -n "$MODEL_ARG" ]; then
      "$WS" install "$MODEL_ARG"
    else
      "$WS" install
    fi
  fi
else
  bold "5. Whisper model (skipped)"
fi

# ---------------------------------------------------------------------------
# Hugging Face token. pyannote's diarization model is GATED — you must accept
# its license once on the HF website, then authenticate once to download.
# After download the model is cached at ~/.cache/huggingface/ and runtime needs
# neither the token nor the network. We write the token to the standard HF
# token file so pyannote/transformers auto-load it; no env var required later.
HF_TOKEN_FILE="$HOME/.cache/huggingface/token"

if [ "$SKIP_HF" -eq 0 ]; then
  bold "6. Hugging Face token (one-time, for pyannote model download)"
  cat <<MSG
  pyannote's diarization model is gated. One-time setup:
    1. Create a free account at https://huggingface.co
    2. Accept the license on ALL THREE of these pages:
         https://huggingface.co/pyannote/speaker-diarization-3.1
         https://huggingface.co/pyannote/segmentation-3.0
         https://huggingface.co/pyannote/speaker-diarization-community-1
       (pyannote 3.4+ pulls the PLDA component from community-1 at runtime)
    3. Create a fine-grained token at https://huggingface.co/settings/tokens
       Scope: "Read access to contents of all public gated repos you can access"
    4. Paste it below.

  Token is saved to $HF_TOKEN_FILE (chmod 600) and used only to download the
  model on first run. No token or network is needed at inference time.

MSG
  if [ -s "$HF_TOKEN_FILE" ]; then
    masked="****$(tail -c 5 "$HF_TOKEN_FILE")"
    printf "  A token is already saved (ends in %s). Replace it? [y/N]: " "$masked"
    read -r ans </dev/tty || ans=""
    if [ "$ans" != "y" ] && [ "$ans" != "Y" ]; then
      ok "kept existing token"
      token=""
    else
      printf "  Paste new HF token: "
      read -rs token </dev/tty || token=""
      echo
    fi
  else
    if [ -n "${HF_TOKEN:-}" ]; then
      printf "  HF_TOKEN is set in your environment. Use it? [Y/n]: "
      read -r ans </dev/tty || ans=""
      if [ "$ans" = "n" ] || [ "$ans" = "N" ]; then
        printf "  Paste HF token (leave blank to skip): "
        read -rs token </dev/tty || token=""
        echo
      else
        token="$HF_TOKEN"
      fi
    else
      printf "  Paste HF token (leave blank to skip): "
      read -rs token </dev/tty || token=""
      echo
    fi
  fi
  if [ -n "${token:-}" ]; then
    mkdir -p "$(dirname "$HF_TOKEN_FILE")"
    printf "%s" "$token" > "$HF_TOKEN_FILE"
    chmod 600 "$HF_TOKEN_FILE"
    ok "saved to $HF_TOKEN_FILE"
  elif [ ! -s "$HF_TOKEN_FILE" ]; then
    warn "no token saved — diarization will fail until you re-run setup"
  fi
else
  bold "6. Hugging Face token (skipped)"
fi

# ---------------------------------------------------------------------------
# LM Studio chat model + STT URL. Settings are persisted in SQLite at
# $LIB/db.sqlite. App migrations are idempotent so pre-creating tables here
# is safe — first app launch will leave them alone.
LIB="${MEETINGNOTES_LIB:-$HOME/Documents/MeetingNotes}"
DB="$LIB/db.sqlite"
LM_DEFAULT="http://localhost:1234"
STT_DEFAULT="http://127.0.0.1:8080"

write_setting() {
  # write_setting KEY JSON_VALUE
  # Escape single quotes for safe SQL literal interpolation. Keys are
  # internal (whitelist) but values contain user input.
  local k="${1//\'/\'\'}"
  local v="${2//\'/\'\'}"
  sqlite3 "$DB" <<SQL
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings (key, value) VALUES ('$k', '$v')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
SQL
}

read_setting() {
  sqlite3 "$DB" "SELECT value FROM settings WHERE key='$1';" 2>/dev/null
}

if [ "$SKIP_LLM" -eq 0 ]; then
  bold "7. LM Studio chat model + STT URL"

  if ! command -v sqlite3 >/dev/null; then
    warn "sqlite3 CLI not found — skipping. Configure via app Settings instead."
  else
    mkdir -p "$LIB"

    # --- LM Studio URL ---
    cur_lm="$(read_setting lmStudioUrl | tr -d '"')"
    cur_lm="${cur_lm:-$LM_DEFAULT}"
    printf "  LM Studio URL [%s]: " "$cur_lm"
    read -r ans </dev/tty || ans=""
    lm_url="${ans:-$cur_lm}"
    write_setting lmStudioUrl "\"$lm_url\""
    ok "lmStudioUrl = $lm_url"

    # --- LLM model picker ---
    if curl -fsS --max-time 3 "$lm_url/v1/models" >/dev/null 2>&1; then
      mapfile -t llm_models < <(curl -fsS "$lm_url/v1/models" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
      if [ "${#llm_models[@]}" -gt 0 ]; then
        echo "  Models loaded in LM Studio:"
        i=1
        for m in "${llm_models[@]}"; do
          printf "    %d) %s\n" "$i" "$m"
          i=$((i + 1))
        done
        cur_llm="$(read_setting llmModel | tr -d '"')"
        printf "  Choose LLM model [1-%d, blank=keep '%s']: " "${#llm_models[@]}" "${cur_llm:-none}"
        read -r ans </dev/tty || ans=""
        if [ -n "$ans" ] && [[ "$ans" =~ ^[0-9]+$ ]] && [ "$ans" -ge 1 ] && [ "$ans" -le "${#llm_models[@]}" ]; then
          chosen="${llm_models[$((ans - 1))]}"
          write_setting llmModel "\"$chosen\""
          ok "llmModel = $chosen"
        else
          ok "kept llmModel = ${cur_llm:-(unset)}"
        fi
      else
        warn "LM Studio reachable but no models loaded — load one in LM Studio, then re-run setup --skip-npm --skip-sidecar --skip-whisper --skip-hf --skip-dist"
      fi
    else
      warn "LM Studio not reachable at $lm_url — start it, load a model, then re-run setup"
      printf "  Enter LLM model name manually (blank to skip): "
      read -r ans </dev/tty || ans=""
      if [ -n "$ans" ]; then
        write_setting llmModel "\"$ans\""
        ok "llmModel = $ans"
      fi
    fi

    # --- STT URL ---
    cur_stt="$(read_setting sttUrl | tr -d '"')"
    cur_stt="${cur_stt:-$STT_DEFAULT}"
    printf "  STT URL (whisper-server) [%s]: " "$cur_stt"
    read -r ans </dev/tty || ans=""
    stt_url="${ans:-$cur_stt}"
    write_setting sttUrl "\"$stt_url\""
    ok "sttUrl = $stt_url"
  fi
else
  bold "7. LM Studio chat model + STT URL (skipped)"
fi

# ---------------------------------------------------------------------------
if [ "$SKIP_DIST" -eq 0 ]; then
  bold "8. Production build (.app)"
  cat <<MSG
  This builds two artifacts:
    a. PyInstaller bundle of the diarization sidecar (Python + pyannote + torch)
       → standalone binary, end-users do NOT need Python installed
       → takes 10–15 minutes, output ~1.5 GB
    b. The packaged macOS .app (electron-builder)
       → embeds the bundle from (a)
       → output: release/MeetingNotes-*.dmg and release/mac-arm64/MeetingNotes.app

MSG
  printf "  Run the production build now? [Y/n]: "
  read -r ans </dev/tty || ans=""
  if [ "$ans" = "n" ] || [ "$ans" = "N" ]; then
    warn "skipped — build later with: npm run dist"
    warn "                  (or just the sidecar bundle: npm run sidecar:bundle)"
  else
    npm run dist
    if [ -d "release" ]; then
      built=$(ls release/*.dmg release/mac-arm64/MeetingNotes.app 2>/dev/null | head -3)
      ok "built: $built"
    fi
  fi
else
  bold "8. Production build (skipped)"
fi

# ---------------------------------------------------------------------------
bold "Done."
cat <<EOF

Run everything (recommended — one command):
  ./scripts/start.sh             # opens the .app (auto-launches LM Studio)
  ./scripts/start.sh --dev       # 'npm run dev' (auto-launches LM Studio)
  ./scripts/start.sh --stop      # stops any leftover whisper-server daemon

Or do it manually:
  Start LM Studio and load a chat LLM (for summarization)
  open release/mac-arm64/MeetingNotes.app
  ./scripts/doctor.sh             # verify the stack

  (Whisper-server is auto-spawned by the app on first transcription
   and shut down after 10 minutes of inactivity to free RAM. You no
   longer need to run './scripts/whisper-server.sh daemon' yourself —
   though if you do, the app will adopt your instance and leave it
   alone.)

Re-run setup any time:
  ./scripts/setup.sh                              # full interactive
  ./scripts/setup.sh --model large-v3             # non-interactive Whisper swap
  ./scripts/setup.sh --skip-npm --skip-sidecar --skip-whisper --skip-hf --skip-dist
                                                  # just the LLM/STT settings step
EOF
