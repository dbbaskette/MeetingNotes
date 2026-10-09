# Microphone packet timing regression

## History

[PR #244](https://github.com/dbbaskette/MeetingNotes/pull/244), merged October 7,
2026 as `1be1704` for 1.14.0, addressed
[issue #173](https://github.com/dbbaskette/MeetingNotes/issues/173) by replacing
tap-driven mixed output with a bounded shared mic/system timeline. It correctly
enabled microphone-only primary recordings and kept source pauses aligned.
However, it committed live output only 120ms behind wall time.

Before that change, the microphone stem was written directly when its callback
arrived. Afterward, mic samples whose timestamps were already written were
discarded. The 4096-frame microphone tap request is in the **input** sample rate:
at 24kHz it represents about 171ms, longer than the 120ms delay. Actual callback
buffers can also differ from the requested size. The October 8 AirPods report
showed near-silent microphone gaps with this ~171ms cadence, also in mixed audio.
The system stem lacked the same periodic, speech-bounded gaps. The previous
October 6 microphone comparison lacked that pattern.

Native capture code was unchanged after #244 through 1.14.8. Later recording
feedback (#247), terminology (#248), UI and Electron dependency changes did not
introduce this fixed-delay path. Historical microphone rate/frame counts were
not retained, so the exact driver configuration for that call is unconfirmed.
This is a supported capture-timing regression, not evidence of speaker naming,
transcription or summarization corrupting the original microphone file.

## Correction

- Seed holdback from the requested microphone buffer duration in the input rate.
- Observe actual converted frame counts and packet-start age at arrival, with
  60ms delivery margin and a 120ms minimum. Holdback only increases, up to one
  second; memory remains two fixed 48kHz PCM rings. This affects recording write
  latency, not file timestamps or live input levels.
- Wait for the first mic packet before initial live output, with a one-second
  maximum grace. A missing microphone cannot block system recording forever.
- Preserve the shared timeline, 50/50 mix, genuine silence, pause/resume and all
  stems' aligned final drain. No sample shifting, replay or time compression.
- Log sampled, numeric-only `recording:capture-timing` metadata: mic format,
  requested/actual frame sizes, packet age, holdback and late-frame counts.
  Unknown fields, paths, device names and content are not forwarded.

An arbitrarily late packet cannot repair already-encoded audio. Beyond the
bounded timing budget, old samples are still discarded and counted. A sudden
larger packet after steady capture may reveal new latency only on arrival; the
budget then grows without replaying output. The counters expose that limit
instead of claiming unlimited buffering or recovery of missing speech.

## Verification and acceptance

The offline reproduction using the old production timeline lost 23.24% of
constant microphone PCM when 8192 converted frames arrived every 170.67ms.
The new regression gate delivers packets after they fill, interleaves fast
system callbacks and the real 20ms output-clock cadence, and requires exact
sample content, source alignment and zero dropped frames for the supported
latency cases. It covers 48/44.1/24/16/8kHz-sized buffers, delivery jitter,
larger-than-requested first packets, startup, silence, resume, absent mic,
disabled mic, bounded holdback and truthful late counters. Encoded dual-tone
AAC checks require signal in every interior 20ms window and aligned stem lengths.
Existing decoded speech, gain, clipping and finalization checks remain.

These are synthetic checks, not real AirPods/device or long-call acceptance.
After installing a build with the fix, use **Settings → Setup & health → Test
recording…** with AirPods selected as the Mac's input: speak continuously, play
the test back, then check a short normal call. Compare microphone and mixed
playback for pumping/cuts and check `recording:capture-timing` logs for the actual
rate/frame sizes and zero `mic_late_frames`. Keep original audio if it fails.
Changing the Mac's input device during capture needs separate hardware testing.
Nothing rewrites or reconstructs silent portions of earlier recordings.
