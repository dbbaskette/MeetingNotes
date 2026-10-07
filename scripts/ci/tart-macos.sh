#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
export TART_NO_AUTO_PRUNE=1
guest_script=scripts/ci/guest-test.sh
if [[ "${1:-}" == --renderer-only ]]; then guest_script=scripts/ci/guest-renderer.sh; shift; fi
exec bash /Users/dbbaskette/Projects/macos-test-suite/scripts/tart-test-vm.sh \
  --project "$project_root" --name meetingnotes \
  --guest "$guest_script" --base tanzu-brand-golden-gate-base --auto "$@"
