#!/usr/bin/env bash
set -euo pipefail
source_root="/Volumes/My Shared Files/source"
results_root="/Volumes/My Shared Files/results"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export npm_config_userconfig=/dev/null
test_mode="${1:-full}"
[[ "$test_mode" == full || "$test_mode" == renderer || "$test_mode" == quick ]] || exit 2
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
if [[ "$test_mode" != renderer ]]; then
# One native build serves both the app and the tests: Vitest runs under
# Electron's own Node, so better-sqlite3 is never rebuilt for system Node.
run_check native-electron npm run rebuild:electron
# SQLite/native-addon suites run in isolated processes. Serialize VM workers
# so concurrent filesystem/SQLite stress fixtures do not starve watcher polls.
run_check tests env ELECTRON_RUN_AS_NODE=1 npx electron node_modules/vitest/vitest.mjs run --pool=forks --maxWorkers=1 --minWorkers=1
fi
if [[ "$test_mode" == full ]]; then
run_check audio-helper bash scripts/ci/audio-helper-smoke.sh "$task_root/native-build"
fi
run_check renderer-types npx tsc --noEmit -p tsconfig.json
run_check fixture-types npx tsc --noEmit -p scripts/library-pagination-fixture/tsconfig.json
run_check build npm run build
run_check main-types npx tsc --noEmit -p tsconfig.node.json
# README and guides: links resolve and version/Electron badges match the code.
run_check docs node scripts/ci/check-docs.mjs
# Whole repository, zero warnings: new lint debt anywhere fails the run.
run_check lint npm run lint
if [[ "$test_mode" == quick ]]; then
  # Fast tier for every branch: install, native build, tests, types, build,
  # lint. It skips the audio helper, benchmark, UI fixtures and packaged app.
  printf 'Electron: ' >> "$results_root/environment.txt"
  node -p 'require("electron/package.json").version' >> "$results_root/environment.txt"
  printf 'PASS\n' > "$results_root/result.txt"
  exit 0
fi
if [[ "$test_mode" == full ]]; then
run_check browse-benchmark env MN_BENCH_REPO="$source_root" node --import tsx scripts/bench-browse.mjs
else
  export MN_FIXTURE_MODES=rows,selection,grouped,startup,settings,sources,capture,epic243,terminology
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
