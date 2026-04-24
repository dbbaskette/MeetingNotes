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
#
# The --exclude-module block trims transitive pulls that diarization does not
# actually exercise at inference time. Each entry below has been verified to
# not break `/health` + a real end-to-end `/diarize` call against a 15-second
# WAV using a cached pyannote model:
#   matplotlib, mpl_toolkits — plotting; pyannote only uses it in its
#                              experiment + metric scripts we never run
#   PIL                      — image ops; same rationale
#   IPython, jupyter, notebook — pulled by some pyannote tutorial imports
#   pytest, _pytest          — test framework pulled by one transitive dep
#
# Modules we tried to exclude but had to restore (inference imports them
# despite being conspicuously absent from the inference code — pyannote's
# dependency graph is less surgical than it looks):
#   pandas                   — ModuleNotFoundError at diarize time
#   opentelemetry            — same
#   grpc                     — not re-tested after opentelemetry restore
#                              (assumed needed since otel imports it)
# Net savings after the back-offs: ~25 MB.
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
  --exclude-module matplotlib \
  --exclude-module mpl_toolkits \
  --exclude-module PIL \
  --exclude-module IPython \
  --exclude-module jupyter \
  --exclude-module notebook \
  --exclude-module pytest \
  --exclude-module _pytest \
  serve.py

# Post-build prune: strip torch subtrees that `--collect-all torch` pulls
# wholesale but inference never touches. Verified by a full end-to-end
# /diarize call on a short WAV after each addition; any entry here that
# broke that smoke has been removed.
#
# Subtrees stripped (measured ~67 MB on top of the --exclude-module wins):
#   torch/include/       C++ headers for compiling torch extensions; we
#                        don't compile extensions at runtime
#   torch/testing/       pytest utilities
#   torch/onnx/          ONNX export path; pyannote doesn't export
#
# Kept even though they look prunable:
#   torch/bin/           torch spawns torch_shm_manager from here for
#                        shared-memory ops — removing it made /diarize
#                        fail with "Unable to find torch_shm_manager"
#   torch/_export/       torch/export/decomp_utils.py imports it, then
#                        config.py does inspect.getsource() on itself —
#                        removing it produced "OSError: could not get
#                        source code" at load time
#   torch/export/        same
#   torch/distributed/   imported unconditionally by torch init
#   torch/_dynamo/       same
#   torch/_inductor/     same
#
# Anyone adding an entry here: rerun the smoke
#   HF_TOKEN=$(cat ~/.cache/huggingface/token) \
#     ./dist/meeting-notes-diarize/meeting-notes-diarize --port 8767 &
#   curl -sS -X POST http://127.0.0.1:8767/diarize \
#     -H 'content-type: application/json' \
#     --data "{\"audio_path\": \"/path/to/short.wav\"}"
# Expect HTTP 200 with non-empty segments array.
TORCH_INTERNAL="dist/meeting-notes-diarize/_internal/torch"
if [ -d "$TORCH_INTERNAL" ]; then
  for sub in include testing onnx; do
    rm -rf "$TORCH_INTERNAL/$sub"
  done
fi

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
