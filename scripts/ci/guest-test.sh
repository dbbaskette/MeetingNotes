#!/usr/bin/env bash
set -euo pipefail
source_root="/Volumes/My Shared Files/source"
results_root="/Volumes/My Shared Files/results"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export npm_config_userconfig=/dev/null
test_mode="${1:-full}"
[[ "$test_mode" == full || "$test_mode" == renderer ]] || exit 2
task_root="$(mktemp -d /tmp/meetingnotes-ci.XXXXXX)"
trap 'printf "Guest exit: %s\n" "$?" >> "$results_root/environment.txt"' EXIT
git_source() { git -c "safe.directory=$source_root" -C "$source_root" "$@"; }
git_source ls-files -z | tar -C "$source_root" -c --null -T - -f - | tar -x -f - -C "$task_root"
cd "$task_root"
{
  sw_vers
  uname -m
  node --version
  npm --version
  printf 'Coverage: %s\n' "$test_mode"
  printf 'Commit: '; git_source rev-parse HEAD
  printf 'Tree: '; git_source rev-parse 'HEAD^{tree}'
  git_source status --short
} > "$results_root/environment.txt"
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 22 ]] || { printf 'Node 22 required\n' >&2; exit 1; }
run_check() {
  local name="$1"; shift
  "$@" 2>&1 | tee "$results_root/$name.log"
  printf '%s: PASS\n' "$name" >> "$results_root/checks.txt"
}
run_check install npm ci
if [[ "$test_mode" == full ]]; then
run_check native-node npm run rebuild:node
# SQLite/native-addon suites run in isolated processes. Serialize VM workers
# so concurrent filesystem/SQLite stress fixtures do not starve watcher polls.
run_check tests npx vitest run --pool=forks --maxWorkers=1 --minWorkers=1
run_check audio-helper bash scripts/ci/audio-helper-smoke.sh "$task_root/native-build"
run_check renderer-types npx tsc --noEmit -p tsconfig.json
run_check fixture-types npx tsc --noEmit -p scripts/library-pagination-fixture/tsconfig.json
run_check build npm run build
# macOS Bash 3 has no mapfile. Read the scoped changed-file list portably.
lint_files=()
while IFS= read -r file; do
  if [[ "$file" == electron/* && "$file" =~ \.(ts|tsx)$ && -f "$file" ]]; then lint_files+=("$file"); fi
done < <(git_source diff --name-only a801017 HEAD)
if ((${#lint_files[@]})); then run_check changed-lint npx eslint "${lint_files[@]}"; fi
run_check browse-benchmark env MN_BENCH_REPO="$source_root" node --import tsx scripts/bench-browse.mjs
run_check native-electron npm run rebuild:electron
else
  export MN_FIXTURE_MODES=selection,grouped,startup,settings,sources,capture,epic243
fi
run_check renderer-fixtures env MN_BENCH_REPO="$source_root" MN_FIXTURE_FOCUS=1 MN_FIXTURE_RESULTS="$results_root" node scripts/library-pagination-fixture.mjs
# An optional task-owned package payload allows the same clean-Mac runner to
# verify the actual packaged main/preload/renderer and bundled inference. It
# is never fetched from a release or installed into /Applications.
if [[ -f "$source_root/.ci-package-fixture/manifest.json" ]]; then
  package_commit="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sourceCommit' "$source_root/.ci-package-fixture/manifest.json")"
  [[ "$package_commit" == "$(git_source rev-parse HEAD)" ]] || { printf 'Stale package payload\n' >&2; exit 1; }
  run_check packaged-runtime bash scripts/ci/package-smoke.sh "$source_root/.ci-package-fixture" "$results_root/package"
else
  printf 'Packaged runtime: not requested (no task-owned payload)\n' >> "$results_root/environment.txt"
fi
printf 'Electron: ' >> "$results_root/environment.txt"
node -p 'require("electron/package.json").version' >> "$results_root/environment.txt"
printf 'PASS\n' > "$results_root/result.txt"
