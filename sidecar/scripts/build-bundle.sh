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
#   scipy.io._fast_matrix_market — Matrix Market format reader; not used
#   hf_xet                   — Xet large-file backend for huggingface_hub;
#                              with a locally-cached model, HF falls back
#                              to plain HTTP cleanly
#   uvloop                   — alternative asyncio loop; pyannote and our
#                              sidecar's stdlib asyncio path don't depend on it
#
# Modules we tried to exclude but had to restore (inference imports them
# despite being conspicuously absent from the inference code — pyannote's
# dependency graph is less surgical than it looks):
#   pandas                   — ModuleNotFoundError at diarize time
#   opentelemetry            — same
#   grpc                     — not re-tested after opentelemetry restore
#                              (assumed needed since otel imports it)
#   scipy.optimize._highspy  — scipy.optimize.__init__ unconditionally
#                              imports _linprog which imports _highspy.
#                              Caught by the /diarize smoke. The chain:
#                              lightning → torchmetrics → scipy.signal →
#                              scipy.interpolate → scipy.optimize.__init__.
# Net savings after the back-offs: ~25 MB before this round, ~+10 MB on
# top from the second-pass excludes above.
# --strip runs `strip -S` on every .so / .dylib in the bundle (debug
# symbols only — preserves dynamic symbol table, weak symbols, and
# everything dlopen/dlsym needs at runtime). Verified bit-identical
# /diarize output on pyannote sample.wav vs the unstripped build.
#
# The big-ticket native libs (libtorch_cpu.dylib, libtorch_python.dylib,
# libpython3.13.dylib) are unaffected — PyTorch's macOS wheel ships
# pre-stripped, and CPython's framework dylib is too. The win
# (~3 MB on _internal) comes from smaller bundled deps that DON'T strip
# upstream: watchfiles, websockets, httptools, scipy's vendored gfortran
# helpers. Marginal but free.
"$VENV_PY" -m PyInstaller \
  --name meeting-notes-diarize \
  --noconfirm \
  --clean \
  --onedir \
  --strip \
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
  --exclude-module scipy.io._fast_matrix_market \
  --exclude-module hf_xet \
  --exclude-module uvloop \
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

# Strip pure-metadata files that PyInstaller's --collect-all hauls in but
# the runtime never reads. Each category here was verified against an
# end-to-end /diarize call.
INTERNAL="dist/meeting-notes-diarize/_internal"
if [ -d "$INTERNAL" ]; then
  # 1. .pyi type stubs — static-type-checker fodder, never imported. The
  #    big offenders are torch/_VF.pyi (~2.1 MB) and
  #    torch/_C/_VariableFunctions.pyi (~2.1 MB) but they exist throughout
  #    the bundle (numpy, scipy, pandas, etc.) and add up.
  find "$INTERNAL" -type f -name '*.pyi' -delete

  # 2. Wheel install metadata. pip writes these so it can later uninstall
  #    or verify a package. At runtime nothing reads them. RECORD alone is
  #    ~2.1 MB for torch-2.11.0.dist-info because every shipped file is
  #    listed with its sha256.
  #
  #    NOTE: we deliberately do NOT delete LICENSE / NOTICE / AUTHORS
  #    inside dist-info dirs — MIT/BSD/Apache-2 require redistributing
  #    those when shipping the package, so they stay even though they're
  #    a few KB each.
  find "$INTERNAL" -type d -name '*.dist-info' | while read -r dinfo; do
    for stale in RECORD WHEEL INSTALLER REQUESTED top_level.txt; do
      rm -f "$dinfo/$stale"
    done
  done

  # 3. torch/bin/protoc — the protobuf compiler is a build-time codegen
  #    tool that generates Python message classes from .proto files. Torch
  #    ships pre-generated message classes, so inference never invokes it.
  #    Two ~4 MB copies are shipped (`protoc` and the versioned alias
  #    `protoc-3.13.0.0`); both are dead weight at runtime.
  rm -f "$INTERNAL/torch/bin/protoc" "$INTERNAL/torch/bin/protoc-3.13.0.0"
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
