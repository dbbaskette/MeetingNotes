#!/usr/bin/env bash
# Install the pyannote diarization sidecar into an isolated venv at sidecar/.venv.
# Nothing is installed into the system Python.
set -euo pipefail
cd "$(dirname "$0")/.."

VENV_DIR=".venv"
VENV_PY="$VENV_DIR/bin/python"

# Recreate the venv if it's missing OR half-built (no python binary inside).
if [ ! -x "$VENV_PY" ]; then
  if [ -d "$VENV_DIR" ]; then
    echo "Removing broken venv at $(pwd)/$VENV_DIR"
    rm -rf "$VENV_DIR"
  fi
  echo "Creating venv at $(pwd)/$VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

# Use the venv's interpreter directly. No 'activate' — that pattern silently
# falls back to system pip if activation fails.
echo "Using interpreter: $(pwd)/$VENV_PY"
"$VENV_PY" -m pip install --upgrade pip
"$VENV_PY" -m pip install -e ".[dev]"

# Sanity-check: confirm we installed into the venv, not the system. A venv
# shares the system interpreter binary by design — the right check is
# sys.prefix vs sys.base_prefix (which differ inside a venv).
if ! "$VENV_PY" -c "import sys; sys.exit(0 if sys.prefix != sys.base_prefix else 1)"; then
  echo "ERROR: $VENV_PY is not running inside a venv." >&2
  exit 1
fi

SITE="$("$VENV_PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
echo
echo "Sidecar ready."
echo "  venv:          $(pwd)/$VENV_DIR"
echo "  python:        $(pwd)/$VENV_PY"
echo "  site-packages: $SITE"
echo "  system python (untouched): $(command -v python3)"
