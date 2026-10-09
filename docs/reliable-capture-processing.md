# Reliable capture, processing and delivery

Epic #242 extends the existing local-first workflow. It does not introduce a
cloud service, enable automation by default, or require a new dashboard.

## Capture and setup

All capture entry points share one recorder reservation, including startup,
Stop, URL commands, detector automation, retries and disposable tests. A Stop
failure keeps controls available until helper exit is confirmed. Restart with
All system audio requires confirmation and retains the selected group.
Source Refresh retains the previous list and group; it never starts capture.

The native helper uses a bounded 48 kHz shared timeline. Mic callbacks can now
produce the primary file even when the selected app is silent. Missing input
callbacks produce correctly positioned silence; app and mic resumption do not
splice time together. Mixed gain remains 50/50 with mic enabled and full system
gain with mic disabled. All stems finalize together after inputs stop.

The output clock now waits for microphone packet duration and observed delivery
latency, rather than always committing audio after 120ms. Holdback grows only
within a one-second bound; the rings remain fixed at two seconds. Initial mic
discovery has a bounded one-second grace so a fast system stream cannot erase
the first larger mic packet. Real source pauses still become positioned silence.
See [microphone timing](microphone-timing.md) for the AirPods regression, synthetic
verification and limits; this is not a claim of live device acceptance.

Live Mic/App/File labels describe observed samples, not a promise that the
saved file is playable. Stream diagnostics disclose numeric dBFS peaks without
announcing every sample. A quiet app during a mic-only recording is not the
same as no audio being recorded. Check finalized playback in Library.

Settings **Setup & health** is compact and read-only. Required permissions,
helper, storage, configured models/endpoints and gated-model access are separate
from optional exporters. Idle managed services are not reported as healthy
running servers. Opening Settings does not record or wake a model service.
**Test recording… → source → Start test** explicitly records eight seconds;
audio is discarded after confirmed Stop, outside watched folders, without a
Library meeting or automatic processing/export. Failed Stop retains the slot
and temporary file until Retry Stop or actual exit confirms safety.

Processing Settings reuses onboarding's Whisper model controls: download,
progress, installed-model refresh and active selection. Downloads validate
HTTP completion, declared length when supplied, and a GGML header before atomic
replacement. This is structural validation, **not a cryptographic checksum or
proof that the model can run**. Invalid downloads keep the previous model.
Custom absolute model paths remain in Advanced. Active processing blocks model
selection/replacement; restart the app to use a changed managed model safely.

## Processing and review

Failures take priority over speaker gates; secondary notes-staleness notices
are quiet disclosures. Plain diagnoses and recommended actions are shared by
Library, detail and pipeline diagnostics. Raw errors and the latest 20 failure/
retry events remain under technical details. Migration 21 adds this bounded
history without relocating recordings.

Inline speaker review shows at most three unresolved voices and links to the
full roster. It uses the same samples, suggestions, confidence/review policy and
bulk assignment as the existing panel. Naming voices never bypasses the gate.
Retry and regeneration explain replacement: notes/action items retain their
existing history; replaced edited transcripts are preserved as
`transcript.before-rerun-*.md` in the meeting folder. Original audio and the
terminology dictionary are retained. Transcript snapshots are local backups,
not another automatic version-restore UI.

Needs attention **View all** and **+N more** open the complete backlog, with
20-item pages per category, consistent counts and existing actions. This uses
thin inbox records, not eager transcript/artifact loading.

**Process recordings automatically when recording stops** defaults off. When
enabled, only new, usable, finalized built-in recordings enter the existing
queue. Imports, historical watcher discovery, recovery, failed startup and test
captures do not auto-enqueue. Pause, cancellation and speaker-review gates keep
their existing meaning. Option-Stop overrides are deferred.

## Stems: explicit compatibility decision

Both STT and diarization continue to consume the same primary mixed timeline.
Independent stem processing remains disabled pending cross-device speech and
overlap attribution evidence. `lib/stem-paths.ts` names and helpers remain for
recovery/trash compatibility; `.voice.m4a`, `.system.m4a`, stored userName and
roster identities are not removed. The former comments claiming active
system-stem diarization were corrected. Synthetic checks are not hardware proof.

## Export safety

Manual and automatic webhooks use the same mine/all/none rules. Mine matches
the configured roster ID or normalized owner name; it does not send colleagues'
tasks solely because an owner ID is absent. Summary-only delivery is supported.
Payloads have the real meeting ID. One logical delivery shares a delivery UUID
and `Idempotency-Key` across retries. Deliberately exporting again creates a
new UUID. Delivery is **at least once**: a timeout can occur after the server
accepts the request. Receivers must persist/deduplicate the UUID; Slack/Telegram
endpoints need not honor the header. The client does not guarantee exactly once
across crashes, restarts or deliberate resends.

Built-in Telegram MarkdownV2 escapes dynamic text before delivery and truncates
raw fields before escaping. Slack headers are plain text capped at 150
characters; dynamic mrkdwn escapes `&<>` while retaining intended formatting.
See the primary [Telegram formatting contract](https://core.telegram.org/bots/api#markdownv2-style)
and [Slack escaping contract](https://docs.slack.dev/messaging/formatting-message-text/).
HTTPS remains required except IPv4/IPv6 localhost development endpoints;
redirects are rejected to avoid forwarding credentials. Logs remain redacted.

Google Tasks follows every `nextPageToken`, including empty intermediate
pages, and coalesces concurrent task-list lookup/creation. No persistent list-ID
cache is introduced. See [Google's pagination contract](https://developers.google.com/workspace/tasks/reference/rest/v1/tasklists/list).

## User verification checklist (deferred by request)

On your usual microphone/output devices, use a short disposable test first.
Then check a normal short meeting and a longer call:

1. Mic on, selected app silent: speak; File/Mic show activity, app-silent copy
   is truthful, primary playback contains speech and exactly one meeting appears.
2. Mic off with app sound, then mic+app: verify expected voices, volume, no
   distortion/clipping, and primary/voice/system durations and timing align.
3. Pause/resume app audio mid-call; verify no missing or duplicated speech/time.
4. Stop, restart with All system audio, and change views: controls remain clear,
   group intent is retained, and finalized audio plays. Check a longer call for drift.
5. Enable auto-process only if desired: a new stopped capture queues once;
   queue pause works and unresolved speakers still require review.

No live microphone/call recording or real-account delivery was performed by
the agent. The owner explicitly authorized merge/issue closure while deferring
this hardware verification. Report any failure with source/device, approximate
time and the retained original audio; reopen #173 if necessary.
