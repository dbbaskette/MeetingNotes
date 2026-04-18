#!/usr/bin/env bash
# Lightweight test-only venv at sidecar/.venv-test — installs only the deps
# needed by tests that mock pyannote/torch. Does NOT install pyannote or torch.
# For actually running diarization, use install.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

VENV_DIR=".venv-test"
VENV_PY="$VENV_DIR/bin/python"

if [ ! -x "$VENV_PY" ]; then
  if [ -d "$VENV_DIR" ]; then rm -rf "$VENV_DIR"; fi
  python3 -m venv "$VENV_DIR"
fi

"$VENV_PY" -m pip install --upgrade pip >/dev/null
"$VENV_PY" -m pip install fastapi pydantic 'uvicorn[standard]' pytest pytest-asyncio httpx python-multipart

echo "Dev-test venv ready at $(pwd)/$VENV_DIR"
