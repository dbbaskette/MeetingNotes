#!/usr/bin/env bash
set -euo pipefail
fixture_root="${1:?Pass the task-owned packaging fixture payload}"
results_root="${2:?Pass the task-owned results directory}"
mkdir -p "$results_root"
task_smoke_root="$(mktemp -d /tmp/meetingnotes-package-smoke-XXXXXX)"
task_profile=''
trap 'if [[ -n "$task_profile" ]]; then rm -rf "$task_profile"; fi; rm -rf "$task_smoke_root"' EXIT
# VirtioFS does not reliably expose framework-link extended attributes. The
# unsigned disposable fixture needs bytes and relative links, not host xattrs.
cp -RX "$fixture_root/MeetingNotes.app" "$task_smoke_root/MeetingNotes.app"
task_app="$task_smoke_root/MeetingNotes.app"
task_bin="$task_app/Contents/MacOS/MeetingNotes"
for rendering in hardware software; do
  task_profile="$(mktemp -d /tmp/meetingnotes-package-smoke-XXXXXX)"
  printf 'synthetic-meetingnotes-package-smoke-v1' > "$task_profile/fixture-marker"
  args=(--meetingnotes-package-smoke)
  if [[ "$rendering" == software ]]; then args+=(--disable-gpu --use-gl=angle --use-angle=swiftshader); fi
  if ! env MN_PACKAGE_SMOKE_DIR="$task_profile" node scripts/ci/package-launch.mjs "$task_bin" "${args[@]}" > "$results_root/$rendering.log" 2>&1; then
    cp -R "$task_profile" "$results_root/$rendering-failure"
    rm -rf "$task_profile"
    exit 1
  fi
  cp "$task_profile/result.json" "$results_root/$rendering.json"
  cp "$task_profile/render.png" "$results_root/$rendering.png"
  rm -rf "$task_profile"
done
env ELECTRON_RUN_AS_NODE=1 "$task_bin" scripts/ci/package-runtime.mjs "$task_app" "$fixture_root" "$results_root" > "$results_root/runtime.log" 2>&1
printf 'PASS packaged renderer (normal + SwiftShader), helper, configured provider transport, offline synthetic inference\n'
