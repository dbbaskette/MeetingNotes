# Meeting artifact demand loading (#209)

## Reproduce

```sh
MN_ARTIFACT_BENCH=1 npx vitest run electron/main/library/artifact-loading-performance.test.ts
```

The opt-in test generates and removes its own temporary fixture, emits a
`MN_ARTIFACT_BENCH_RESULT` JSON report, and runs three comparisons. It is skipped
by the ordinary test suite. No runtime dependency or production instrumentation
is added. Timing is reported, not asserted as a machine-independent CI budget.
Assertions cover file-byte accounting, absence of shell transcript fields,
cold/warm shell equality, and the historical duplicate raw read/parse.

## Fixture and measurement boundaries

Recorded September 8, 2026, on Apple M5 Pro, macOS arm64, Node v25.9.0,
Vitest 1.6.1. One generated fixture is reused across the three rounds:

| Artifact | Shape | UTF-8 bytes |
| --- | --- | ---: |
| `transcript.md` | 250,000 lines of stress-expanded speaker/timestamp markdown | 27,686,820 |
| `transcript.raw.json` | Full raw text and 14,400 one-second segments | 3,138,013 |
| `diarization.json` | 4,800 three-second turns, four speakers | 237,440 |
| `summary.md` | Heading and 32 decision bullets | 2,014 |

The JSON timestamps cover four hours. Markdown deliberately repeats those
utterances to reach the required stress volume; it is not a realistic claim of
250,000 utterances in four hours or a one-to-one markdown/JSON segment mapping.
JSON carries a small benchmark tag so parse instrumentation excludes unrelated
framework work. Larger real JSON, embedding-heavy diarization, slower CPUs, and
larger summaries need their own measurements.

The shell and optional-artifact probes invoke the actual registered IPC handlers
and real `ArtifactCache`. Repositories are deterministic in-memory stubs, with a
completed meeting, four confirmed speakers, and no action items. The historical
baseline reproduces the artifact sequence from `meetings:get` at `2d3f216`:
synchronous diarization/raw reads and parsing, actual speaker-review metadata
construction, a second raw read/parse for the preview, and markdown/summary
reads. Its non-artifact response fields use the same shell metadata template.
Database latency, active-stage ETA work, renderer rendering, audio, and actual
Electron transport are outside this benchmark.

“Cold” means a fresh application `ArtifactCache`; “warm” means the immediately
following shell request on that cache. The operating-system page cache is **not**
flushed, and fixture generation has already written the files. Round 2 reverses
old-versus-shell order to reduce systematic order bias. Warm optional probes
preload all artifact source bytes before their measurements.

- Wall time includes handler work plus `JSON.stringify` and UTF-8 byte counting
  of the response. Serialization is a comparable payload-size proxy, not a
  measurement of Electron structured-clone IPC.
- Event-loop delay is the maximum lateness of a 1 ms interval armed immediately
  before loading: `max(0, elapsedSincePreviousTick - 1 ms)`. A 5 ms drain lets a
  blocked timer fire after loading and is excluded from wall time. Timer
  quantization/scheduling noise dominates sub-millisecond shell results.
- Bytes read counts UTF-8 content delivered by actual artifact reads, including
  the baseline's duplicate raw read. It excludes stat metadata and physical disk
  traffic. Cache hits still perform fingerprint stats.
- JSON parse durations time individual fixture `JSON.parse` calls only. The
  reported total excludes file I/O, metadata matching, and serialization.

An initial native histogram sampler missed same-turn synchronous blocking and
was discarded before retaining measurements. A separate three-repeat 75 ms
busy-loop check reproduced that miss and confirmed the explicit timer detects
approximately 74 ms lateness. The results below use the corrected timer.

## Three-run results

All times are milliseconds, rounded to six decimal places; byte counts are exact.

| Run | Path | Wall | Max loop delay | Bytes read | JSON parse total | Serialized bytes |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Old synchronous all-artifact | 100.561917 | 99.711875 | 34,202,300 | 4.871292 | 29,253,808 |
| 1 | Shell cold | 0.254166 | 0.426166 | 2,014 | 0 | 2,882 |
| 1 | Shell warm | 0.159250 | 0.320292 | 0 | 0 | 2,882 |
| 2 | Old synchronous all-artifact | 87.684042 | 87.143791 | 34,202,300 | 4.714042 | 29,253,808 |
| 2 | Shell cold | 0.289667 | 0.204541 | 2,014 | 0 | 2,882 |
| 2 | Shell warm | 0.125625 | 0.159291 | 0 | 0 | 2,882 |
| 3 | Old synchronous all-artifact | 85.619792 | 85.830208 | 34,202,300 | 4.251458 | 29,253,808 |
| 3 | Shell cold | 0.340667 | 0.521167 | 2,014 | 0 | 2,882 |
| 3 | Shell warm | 0.061125 | 0.215708 | 0 | 0 | 2,882 |

The baseline wall-time range is 14.942125 ms. Even the fastest baseline minus
the slowest cold shell is 85.279125 ms, comfortably larger than that observed
run-to-run spread. This supports the initial-shell improvement **for this
fixture and environment**. It does not establish a production percentile or an
end-to-end UI speedup. The shell consistently avoids 34,200,286 content bytes on
a cold request and removes 29,250,926 serialized bytes from the initial response.

No standalone cold-versus-warm latency claim is retained: differences are small
and not consistently larger than the observed sub-millisecond timing variation.
The repeatable cache result is that warm shell requests read zero content bytes
instead of 2,014. The benchmark does not justify additional cache micro-optimizations.

## Worker parsing decision and remaining work

Warm-source probes exercise actual transcript and speaker-review endpoints:

| Run | Optional endpoint | Wall | Max loop delay | Bytes read | JSON parse total | Serialized bytes |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Transcript | 24.601875 | 23.657334 | 0 | 2.056625 | 29,250,551 |
| 1 | Speaker review | 76.011625 | 75.059458 | 0 | 2.646959 | 750 |
| 2 | Transcript | 23.379959 | 22.439542 | 0 | 1.926042 | 29,250,551 |
| 2 | Speaker review | 72.839916 | 71.786917 | 0 | 2.328667 | 750 |
| 3 | Transcript | 22.498000 | 21.545167 | 0 | 1.965292 | 29,250,551 |
| 3 | Speaker review | 67.875625 | 66.917125 | 0 | 2.184084 | 750 |

Individual JSON parse tasks (milliseconds):

| Run | Old diarization | Old raw, review | Old raw, preview | Transcript raw | Review diarization | Review raw |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.408917 | 2.045208 | 2.417167 | 2.056625 | 0.359834 | 2.287125 |
| 2 | 0.609792 | 2.097166 | 2.007084 | 1.926042 | 0.361292 | 1.967375 |
| 3 | 0.363916 | 1.927875 | 1.959667 | 1.965292 | 0.366417 | 1.817667 |

The largest individual parse is 2.417167 ms; zero rounds contain a parse above
the 50 ms threshold. Worker-backed JSON parsing was evaluated and **not
retained**. Worker startup/lifecycle, termination/failure handling, and object
transfer add complexity without a measured parsing long task to address here.
No worker implementation or worker failure/termination tests were needed.
The benchmark reports `workerRequired: true` if parse tasks exceed 50 ms in at
least two rounds, to flag reevaluation on other fixtures/hardware; it does not
silently change runtime behavior.

The speaker-review endpoint still has overlap matching, now a sorted two-pointer
pass instead of a nested full scan, plus a single sweep for per-speaker line
counts. Bulk assign uses the async ArtifactCache path. The transcript endpoint
returns markdown alone when `transcript.md` exists and only reads the raw
preview as a fallback.

| Evaluated idea | Verdict | Evidence |
| --- | --- | --- |
| Separate initial shell from optional artifacts | Keep the measured claim | Baseline/cold-shell gap exceeds three-run spread; content/payload bytes sharply lower |
| Source-cache warm shell | Keep byte-read result only | Zero versus 2,014 content bytes; no standalone latency claim |
| Worker JSON parsing | Not retained | Every parse below 2.42 ms; none above 50 ms |
| Faster review metadata computation | Two-pointer merge + one-pass counts | Nested scan was the long task; parse-only offload does not target it |

## Verification

- Opt-in command above: passed, three rounds plus optional parse probes.
- `npx tsc --noEmit -p tsconfig.json`: passed.
- `npm run build`: passed; Vite reports the existing renderer chunk above 500 kB
  (509.01 kB minified, 149.60 kB gzip).
- `git diff --check`: passed.
- `npx vitest run --pool=forks --isolate --maxWorkers=1 --minWorkers=1`:
  108 files passed, one benchmark file skipped; 760 tests passed, three skipped.
  The initial parallel-worker run had one watcher release-path timeout; the
  unchanged watcher passed all 10 tests alone and in the final complete run.
- `npm run rebuild:electron`: initial restricted-network attempt failed with
  `ENOTFOUND registry.npmjs.org`; the authorized network-enabled retry succeeded.
  An `ELECTRON_RUN_AS_NODE=1` SQLite `select 1` smoke check then passed under
  Electron 30.5.1 / module ABI 123 using this worktree's restored binary.

The native-module check is not an interactive Electron UI smoke test. No claim
of full GUI verification is made here.
