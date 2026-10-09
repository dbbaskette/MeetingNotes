#!/usr/bin/env bash
# Launch the built app (run `npm run build` first, or use `npm run
# smoke:source`) against a disposable synthetic library and check that the
# Library renders. Uses no real meetings, settings or keychain items, registers
# no URL handler, and removes its fixture afterwards.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
fixture="$(mktemp -d /tmp/meetingnotes-package-smoke-XXXXXX)"
trap 'rm -rf "$fixture"' EXIT
printf 'synthetic-meetingnotes-package-smoke-v1' > "$fixture/fixture-marker"
mkdir -p "$fixture/recordings"
cd "$root"
[[ -f dist/electron/main/index.js && -f dist/renderer/index.html ]] || { printf 'Run npm run build first.\n' >&2; exit 1; }

MN_PACKAGE_SMOKE_DIR="$fixture" ELECTRON_RUN_AS_NODE='' ELECTRON_ENABLE_LOGGING=1 \
  ./node_modules/.bin/electron scripts/ci/source-launch.mjs "$root" --meetingnotes-package-smoke -ApplePersistenceIgnoreState YES > "$fixture/stdout.txt" 2>&1 &
pid=$!
# The smoke quits by itself within a few seconds. A hang usually means a
# modal (for example a keychain prompt) is waiting on screen.
for _ in $(seq 1 90); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
if kill -0 "$pid" 2>/dev/null; then
  printf 'FAIL: the app did not exit within 90 seconds.\n' >&2
  pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  exit 1
fi
wait "$pid"; code=$?

problems="$(grep -cE '"level":"(error|warn)"' "$fixture/app.log" 2>/dev/null || true)"
violations="$(grep -c 'Refused to' "$fixture/stdout.txt" 2>/dev/null || true)"
if ((code != 0)) || [[ ! -f "$fixture/result.json" ]]; then
  printf 'FAIL (exit %s): %s\n' "$code" "$(cat "$fixture/failure.txt" 2>/dev/null || echo 'no result written')" >&2
  grep -E 'CONSOLE|Error' "$fixture/stdout.txt" | cut -c1-300 | tail -10 >&2
  exit 1
fi
if [[ "${problems:-0}" != 0 || "${violations:-0}" != 0 ]]; then
  printf 'FAIL: %s warning/error log lines, %s Content-Security-Policy violations.\n' "${problems:-0}" "${violations:-0}" >&2
  grep -E '"level":"(error|warn)"' "$fixture/app.log" | cut -c1-300 | head -5 >&2
  grep 'Refused to' "$fixture/stdout.txt" | cut -c1-300 | head -5 >&2
  exit 1
fi
if [[ -n "${MN_SMOKE_SCREENSHOT:-}" ]]; then cp "$fixture/render.png" "$MN_SMOKE_SCREENSHOT"; fi
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(`PASS source launch: ${r.view} view, ${r.rows} rows, next page ${r.hasNext}`)' "$fixture/result.json"
