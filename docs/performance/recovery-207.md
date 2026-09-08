# Recovery inbox performance (#207)

## Design

The service caches per-file duration promises by path, size, modification time
and change time. Missing/empty files invalidate their entries; listing prunes
files no longer belonging to the recovery backlog. Negative probe results
expire after 30 seconds so transient failures can recover without file changes.
Changed files invalidate results immediately. The cache is
process-local and shared by overlapping refreshes.

Four listing workers use a service-wide four-probe semaphore. Each completed
entry is sent only to the requesting renderer, tagged with its request ID and
original index. The preload subscribes before invoking and unsubscribes in
`finally`; the Library ignores superseded or unmounted refreshes. The original
no-argument list API and final ordering remain compatible.

## Reproduction

Run `MN_RECOVERY_BENCH=1 npx vitest run electron/main/recording/recovery-performance.test.ts`.
The opt-in fixture creates 113 one-second PCM WAV files in a temporary directory,
uses real ffprobe subprocesses, and compares the original sequential probe loop
against the new service. It repeats both an initial and unchanged-file refresh
three times. Each optimized initial run invalidates the application cache.
“Cold” here means application-cache cold, **not** OS filesystem-cache cold.
The baseline isolates the original sequential probing algorithm, not the full
Electron UI; database/IPC/rendering and large/corrupt media are not benchmarked.

## Measurements (local macOS, 2026-09-08)

| Run | Baseline initial | Baseline repeat | New initial | New repeat | First entry |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1765 ms | 1790 ms | 487 ms | 1.7 ms | 16.7 ms |
| 2 | 1721 ms | 1743 ms | 499 ms | 3.0 ms | 17.2 ms |
| 3 | 2449 ms | 1995 ms | 583 ms | 2.7 ms | 21.0 ms |

The initial speedup exceeds run-to-run variation; repeat refreshes avoid all
113 subprocesses. Keep the optimization. These are fixture results, not a claim
about every user's recordings. Automated tests additionally cover cache
invalidation, missing/recreated files, stem classification, probe failures,
overlapping requests, request isolation and listener cleanup.

## Verification

- `npm run build`: passed (existing >500 kB bundle warning remains).
- `npx vitest run --pool=forks --maxWorkers=1 --minWorkers=1`: 710 passed,
  1 opt-in benchmark skipped, 103 files passed.
- Opt-in real-ffprobe benchmark: all 5 tests passed separately.
- `git diff --check`: passed.

The default `npm test` worker run exited with native signal 139 without an
assertion failure. The complete isolated-process run above passed; the root
cause of the default-runner crash was not established in this change.
