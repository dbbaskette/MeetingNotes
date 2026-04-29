#!/usr/bin/env bash
# Verify the local stack MeetingNotes depends on. Read-only — never starts services.
set -uo pipefail

LM_STUDIO_URL="${LM_STUDIO_URL:-http://localhost:1234}"
STT_URL="${STT_URL:-http://127.0.0.1:8080}"
DIAR_URL="${DIAR_URL:-http://127.0.0.1:8765}"
LIB="${MEETINGNOTES_LIB:-$HOME/Documents/MeetingNotes}"
AUDIO_HIJACK_DIR="${AUDIO_HIJACK_DIR:-$HOME/Music/Audio Hijack}"

pass=0; fail=0; warn=0
ok()   { printf "  \033[32mok\033[0m   %s\n" "$1"; pass=$((pass+1)); }
bad()  { printf "  \033[31mFAIL\033[0m %s\n" "$1"; fail=$((fail+1)); }
hmm()  { printf "  \033[33mwarn\033[0m %s\n" "$1"; warn=$((warn+1)); }

section() { printf "\n%s\n" "$1"; }

http_ok() {
  local url="$1"
  curl -fsS -o /dev/null --max-time 3 "$url"
}

section "Binaries"
for bin in node npm python3 ffmpeg ffprobe; do
  if command -v "$bin" >/dev/null; then ok "$bin: $(command -v "$bin")"; else bad "$bin: not found"; fi
done
if command -v whisper-server >/dev/null; then ok "whisper-server: $(command -v whisper-server)"
else bad "whisper-server: not found (brew install whisper-cpp)"; fi

section "Filesystem"
[ -d "$LIB" ] && ok "library dir: $LIB" || bad "library dir missing: $LIB"
[ -d "$LIB/meetings" ] && ok "$LIB/meetings" || hmm "$LIB/meetings missing (will be created on first run)"
[ -d "$LIB/speakers/embeddings" ] && ok "$LIB/speakers/embeddings" || hmm "speakers/embeddings missing"
if [ -d "$AUDIO_HIJACK_DIR" ]; then ok "Audio Hijack output dir: $AUDIO_HIJACK_DIR"
else hmm "Audio Hijack output dir not found at $AUDIO_HIJACK_DIR (set audioWatchPath in app settings)"; fi

section "Sidecar (pyannote)"
if [ -x "sidecar/.venv/bin/python" ]; then
  ok "sidecar venv present"
else
  bad "sidecar venv missing — run: (cd sidecar && ./scripts/install.sh)"
fi
if [ -s "$HOME/.cache/huggingface/token" ]; then
  ok "HF token saved at ~/.cache/huggingface/token (used only for first-time download)"
elif [ -n "${HF_TOKEN:-}" ]; then
  hmm "HF_TOKEN exported but not persisted — re-run ./scripts/setup.sh to save it"
else
  bad "no HF token found — diarization will fail on first model download (run ./scripts/setup.sh)"
fi
if [ -d "$HOME/.cache/huggingface/hub" ]; then
  ok "HF model cache present (offline diarization will work)"
fi

section "Services"
if http_ok "$STT_URL/v1/models"; then
  ok "whisper-server reachable at $STT_URL"
else
  hmm "whisper-server not currently running at $STT_URL (the app spawns it on first transcribe and shuts it down after 10 min idle)"
fi

if http_ok "$LM_STUDIO_URL/v1/models"; then
  models=$(curl -fsS "$LM_STUDIO_URL/v1/models" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -5 | paste -sd, -)
  ok "LM Studio reachable at $LM_STUDIO_URL (models: ${models:-none loaded})"
else
  bad "LM Studio not reachable at $LM_STUDIO_URL — start LM Studio and enable its server"
fi

if http_ok "$DIAR_URL/health" || http_ok "$DIAR_URL/"; then
  ok "diarization sidecar reachable at $DIAR_URL"
else
  hmm "diarization sidecar not currently running at $DIAR_URL (the app spawns it on first diarize and shuts it down after 10 min idle)"
fi

section "Native modules"
if node -e "require('better-sqlite3')" 2>/dev/null; then
  ok "better-sqlite3 loads under Node (tests will work)"
else
  hmm "better-sqlite3 not loadable under Node (run: npm run rebuild:node before vitest)"
fi

section "Summary"
printf "  %d ok, %d warn, %d fail\n" "$pass" "$warn" "$fail"
[ "$fail" -eq 0 ]
