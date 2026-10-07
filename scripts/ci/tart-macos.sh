#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
export TART_NO_AUTO_PRUNE=1
exec bash /Users/dbbaskette/Projects/macos-test-suite/scripts/tart-test-vm.sh \
  --project "$project_root" --name meetingnotes \
  --guest scripts/ci/guest-test.sh --base tanzu-brand-golden-gate-base --auto "$@"
