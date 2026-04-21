#!/usr/bin/env bash
# Bundle the diarization sidecar into a standalone macOS binary using PyInstaller.
# Output: sidecar/dist/meeting-notes-diarize/meeting-notes-diarize (onedir layout)
# This binary embeds Python + pyannote + torch — no Python install required by users.
set -euo pipefail
cd "$(dirname "$0")/.."

VENV_PY=".venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  echo "ERROR: sidecar venv not found at $(pwd)/.venv. Run scripts/install.sh first." >&2
  exit 1
fi

# Install PyInstaller inside the same venv (idempotent).
"$VENV_PY" -m pip install --quiet 'pyinstaller>=6.10'

rm -rf build dist

# Stamp a build id so the Electron supervisor can detect stale sidecars from a
# previous app version still holding port 8765, kill them, and spawn the fresh
# bundle. Without this the user has to manually `lsof -ti :8765 | xargs kill`
# after every rebuild.
BUILD_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD 2>/dev/null || echo local)"

# pyannote loads model files dynamically and registers many submodules. The
# common-issue collect-* flags below pull those in. torch is huge but standard.
"$VENV_PY" -m PyInstaller \
  --name meeting-notes-diarize \
  --noconfirm \
  --clean \
  --onedir \
  --console \
  --collect-all pyannote.audio \
  --collect-all torch \
  --collect-all torchaudio \
  --collect-all speechbrain \
  --collect-data lightning_fabric \
  --collect-data pytorch_lightning \
  --hidden-import sklearn.utils._typedefs \
  --hidden-import sklearn.neighbors._partition_nodes \
  serve.py

# Write BUILD_ID next to the bundle. The sidecar reads it at startup and
# reports it on /health; the supervisor reads this file to know what's fresh.
printf '%s\n' "$BUILD_ID" > dist/BUILD_ID
printf '%s\n' "$BUILD_ID" > BUILD_ID

echo "BUILD_ID: $BUILD_ID"
echo
echo "Bundle ready: $(pwd)/dist/meeting-notes-diarize/meeting-notes-diarize"
echo "Smoke test it with:"
echo "  ./dist/meeting-notes-diarize/meeting-notes-diarize --port 8765 &"
echo "  curl http://127.0.0.1:8765/health"
