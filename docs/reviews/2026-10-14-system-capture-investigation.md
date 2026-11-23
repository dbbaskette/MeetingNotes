# Silent system capture: October 14, 2026

## Confirmed result

One Zoom meeting recorded on October 14, 2026 has microphone audio but no captured system audio. Recording session: `6d383e90`. (The meeting title and ID are left out of this public copy.)

The recording ran from 10:59:44 to 11:54:25 Eastern, with encoded duration 3280.768 seconds (54 minutes 40.768 seconds). The installed application is version 1.14.10. Diagnosis used read-only database/log inspection and audio decoding; original recordings and meeting artifacts were not modified.

## Evidence

| Artifact | Bytes | Full-file decoded levels |
| --- | ---: | --- |
| `recording-20261014-145944-6d383e90.system.m4a` | 1,318,171 | Exact digital silence: minimum and maximum samples 0; peak/RMS negative infinity |
| `recording-20261014-145944-6d383e90.voice.m4a` | 51,745,876 | Mean -45.1 dBFS; maximum 0.0 dBFS |
| `recording-20261014-145944-6d383e90.m4a` | 51,885,207 | Mean -51.2 dBFS; maximum -5.7 dBFS |

All three AAC files decode successfully and report the same duration. Exact silence was verified with ffmpeg `astats` across all 157,474,752 decoded system-stem samples. The main file's lower level is consistent with the current 50/50 mixing of a microphone signal and silence. There is no system audio to recover from this recording's retained system stem.

The recording was started automatically for Zoom, targeting PID 492. The app logged 648 sampled microphone `capture_timing` events and zero system `capture_timing` events. Final late-frame counters were both zero. Those counters do not establish capture success: absent inputs can produce zero late frames.

Neighboring Zoom sessions targeted the same PID and did deliver system buffers:

| Session | Started, Eastern | System timing events | First five minutes' system mean/peak |
| --- | --- | ---: | --- |
| `6b42833e` | October 13, 16:01 | 654 | -18.6 / 0.0 dBFS |
| `650cef52` | October 14, 12:01 | 711 | -22.1 / -0.3 dBFS |
| `754f1a3c` | October 14, 13:02 | 527 | -22.9 / -0.6 dBFS |

No new recording, microphone capture, playback, process restart, permission change, or model action was initiated during investigation.

## Supported diagnosis and limits

The failure occurred before system samples reached the shared capture timeline. Processing, speaker labeling, and playback did not remove an otherwise audible system recording.

The successful neighboring sessions make a permanent permission failure or consistently wrong Zoom PID less likely. An intermittent tap/aggregate startup or route/conversion problem is plausible. The exact underlying cause is unconfirmed.

`Recorder.start()` emits `started` after `AudioDeviceStart` succeeds, without requiring a usable system packet. `handleIOProc` can also return before emitting `capture_timing` if it receives empty data, cannot wrap the PCM format, or encounters a conversion error. Therefore, zero system timing events does not prove that the IOProc itself never fired.

The helper emits tap-format, device-running, IOProc-count, buffer, and conversion diagnostics, but `RecordingManager.handleLine` persists only mic-format and capture-timing diagnostic stages. Historical logs cannot distinguish those failure paths for this meeting. The user subsequently confirmed listening through AirPods or a Bluetooth headset. The exact headset and whether the route changed after recording started remain unconfirmed.

## Bluetooth routing follow-up

After the user's device clarification, read-only code and CoreAudio inspection identified a route-selection weakness worth reproducing:

- `attachProcessTap()` anchors the aggregate to `readDefaultSystemOutputDeviceID()`, which reads `kAudioHardwarePropertyDefaultSystemOutputDevice`.
- Apple's local SDK header describes that selector as the device for system-related sounds, including alerts. The distinct `kAudioHardwarePropertyDefaultOutputDevice` describes the default audio output. A call application's explicitly selected output can also differ from either default.
- The selected anchor UID is set during attachment. The current recorder has no output-route property listener to update that attachment if the route changes.
- A read-only CoreAudio query after the meeting showed both default output selectors on the same built-in 48kHz device. This current state does not establish the route used during the failed Bluetooth call and does not reproduce the failure.

The combination of Bluetooth use and zero delivered system packets makes startup/route handling a stronger investigation lead. It remains a hypothesis, not a proven attribution to AirPods or a demonstrated fix. The next reproduction should compare the application's active output, media default, alert default, tap format, and aggregate callback delivery while using Bluetooth, including a controlled route change. Select and observe the actual capture route rather than assuming either default always represents Zoom's output.

## Why the UI can look active

`LiveRecordingRow` binds its main VU meter to `peaks.mixed`. Microphone-only input therefore moves that meter. Separate Mic, App, and File indicators use source-specific signal events, and current code includes an app-silent warning and an explicit restart with All system audio. A moving main meter establishes mixed-file activity, not receipt of the other participants' audio.

## Focused follow-up

1. Retain bounded numeric tap diagnostics, including IOProc count, delivered frame count, conversion failures, and last usable system-packet age; avoid device names, paths, or meeting content in diagnostic payloads.
2. Distinguish “no system samples received” from delivered silence. Detect startup starvation and later missing callbacks independently of microphone/file activity. Keep microphone capture intact while surfacing the problem prominently, including while another view is open.
3. Evaluate active-output selection and route-change handling together with bounded, same-source tap reinitialization for verified callback starvation. Do not automatically broaden capture to all apps; keep that transition explicit. Preserve original output and maintain the shared clock during any recovery.
4. Reproduce with disposable synthetic inputs and the affected physical-device route. Cover zero callbacks, empty buffers, conversion failure, ordinary silent participants, resumed audio, and output-device changes. Synthetic timeline tests alone do not establish CoreAudio hardware reliability.
5. Before the next important call, make an explicit short test with audible computer playback plus microphone speech and listen to the saved file. If the App indicator remains inactive or diagnostics say “waiting for samples,” use the existing explicit restart control and verify playback before relying on it.

Relevant existing files: `audio-tap/Sources/meeting-notes-tap/Recorder.swift`, `electron/main/recording/manager.ts`, `electron/renderer/src/components/LiveRecordingRow.tsx`, and `electron/renderer/src/lib/capture-health.ts`.
