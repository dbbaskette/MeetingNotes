#!/usr/bin/env bash
# Build both native helpers and the installer. Retain previous installers.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ $# == 0 ]] || { echo 'Usage: scripts/rebuild.sh (native-only full build)' >&2; exit 2; }
npm run rebuild:electron
npm run dist
