#!/usr/bin/env bash
# Shared read-only configuration resolution. The settings database stays at
# its stable app location even when the meeting library moves elsewhere.
doctor_settings_db="${MEETINGNOTES_SETTINGS_DB:-$HOME/Documents/MeetingNotes/db.sqlite}"
setting() {
  case "$1" in libraryPath|sttUrl|summaryProvider|lmStudioUrl) ;; *) return 0 ;; esac
  [[ -f "$doctor_settings_db" ]] || return 0
  sqlite3 -readonly "$doctor_settings_db" \
    "SELECT CASE WHEN json_valid(value) THEN json_extract(value, '$') END FROM settings WHERE key='$1';" \
    2>/dev/null || true
}
LIB="${MEETINGNOTES_LIB:-$(setting libraryPath)}"
LIB="${LIB:-$HOME/Documents/MeetingNotes}"
STT_URL="${STT_URL:-$(setting sttUrl)}"
STT_URL="${STT_URL:-http://127.0.0.1:8080}"
PROVIDER="$(setting summaryProvider)"
case "$PROVIDER" in lm-studio|ollama) ;; *) PROVIDER=external ;; esac
if [[ -n "${LM_STUDIO_URL:-}" ]]; then
  LLM_URL="$LM_STUDIO_URL"
else
  case "$PROVIDER" in
    ollama) LLM_URL=http://127.0.0.1:11434 ;;
    lm-studio) LLM_URL=http://127.0.0.1:1234 ;;
    *) LLM_URL="$(setting lmStudioUrl)"; LLM_URL="${LLM_URL:-http://localhost:1234}" ;;
  esac
fi
STT_URL="${STT_URL%/}"
LLM_URL="${LLM_URL%/}"
