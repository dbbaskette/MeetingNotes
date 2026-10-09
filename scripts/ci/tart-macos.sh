#!/usr/bin/env bash
# Local CI entry point. Runs the suite in a disposable Tart macOS clone and,
# for a clean committed tree, records the result on GitHub as a commit status
# so a pull request shows which commit last passed.
#
#   tart-macos.sh                 full suite            -> status "tart-ci"
#   tart-macos.sh --quick         install/tests/types/build/lint only
#                                                       -> status "tart-ci/quick"
#   tart-macos.sh --renderer-only UI fixtures only      -> no status
#   --no-status                   never post a status
#   --dry-run                     show the plan only    -> no status
set -uo pipefail
project_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
export TART_NO_AUTO_PRUNE=1
guest_script=scripts/ci/guest-test.sh
status_context=tart-ci
post_status=1
passthrough=()
for arg in "$@"; do
  case "$arg" in
    --renderer-only) guest_script=scripts/ci/guest-renderer.sh; post_status=0 ;;
    --quick) guest_script=scripts/ci/guest-quick.sh; status_context=tart-ci/quick ;;
    --no-status) post_status=0 ;;
    --dry-run) post_status=0; passthrough+=("$arg") ;;
    *) passthrough+=("$arg") ;;
  esac
done

head_sha="$(git -C "$project_root" rev-parse HEAD)"
# A status claims "this commit passed". Uncommitted edits to tracked files
# would make that claim false; the guest only ever sees tracked files, so
# untracked files do not matter.
if [[ -n "$(git -C "$project_root" status --porcelain --untracked-files=no)" ]]; then post_status=0; fi

bash /Users/dbbaskette/Projects/macos-test-suite/scripts/tart-test-vm.sh \
  --project "$project_root" --name meetingnotes \
  --guest "$guest_script" --base tanzu-brand-golden-gate-base --auto ${passthrough[@]+"${passthrough[@]}"}
exit_code=$?

if ((post_status)) && command -v gh >/dev/null; then
  if ((exit_code == 0)); then state=success; description="Passed on the local Tart runner"
  else state=failure; description="Failed on the local Tart runner (exit $exit_code)"; fi
  slug="$(cd "$project_root" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"
  if [[ -n "$slug" ]] && gh api "repos/$slug/statuses/$head_sha" -f state="$state" -f context="$status_context" \
      -f description="$description" >/dev/null 2>&1; then
    printf 'Posted %s=%s for %s\n' "$status_context" "$state" "${head_sha:0:7}"
  else
    printf 'Could not post the %s status for %s (commit not pushed, or gh not signed in).\n' "$status_context" "${head_sha:0:7}" >&2
  fi
fi
exit "$exit_code"
