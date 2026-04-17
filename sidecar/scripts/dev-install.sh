#!/usr/bin/env bash
# Lightweight test-only venv — installs just the deps needed to run unit tests
# that mock pyannote/torch. Does NOT install pyannote or torch.
# Use this for developer machines running the Vitest + pytest suites.
# For production (actually running diarization), use install.sh instead.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d ".venv-test" ]; then
  python3 -m venv .venv-test
fi
# shellcheck disable=SC1091
source .venv-test/bin/activate
pip install --upgrade pip >/dev/null
pip install fastapi pydantic 'uvicorn[standard]' pytest pytest-asyncio httpx python-multipart
echo "Dev-test venv ready at sidecar/.venv-test"
