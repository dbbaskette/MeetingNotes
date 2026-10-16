# Native speech beta

**As of 1.16.0, the regular app includes the native engines.** Follow the [regular-app upgrade guide](../../README.md#upgrading-to-1160-what-to-do) for recording, notes and exports. This page documents the retained, isolated **MeetingNotes Beta** 1.15.0-beta.1 comparison workspace. Its copied results/profiles are not automatically imported into the regular library.

The first beta uses English (en-US). It is a speech-comparison workspace, not a replacement for the regular app's recording, summaries, and integrations.

## Try old meetings safely

1. Build with `npm run dist:beta`, or run the beta from source with `npm run beta` on Apple Silicon/macOS 26+ with a suitable Xcode SDK.
2. Finish recording/processing in stable MeetingNotes, then close it. Open the beta and choose your existing **library folder** (the folder containing `db.sqlite`). Custom library locations are supported.
3. Review the source, destination, disk estimate, and missing-file count. Click **Copy library for testing**. This is a one-time snapshot; the beta does not share the stable database or write results back.
4. Open **Speech setup** to provision Apple assets and the approximately 11 MB pinned SpeakerKit model set. Internet is needed for setup, not inference. No HF token is sent or requested.
5. Choose an old meeting. **Re-transcribe only** combines new Apple text with the original saved speaker turns/names. **Re-transcribe + identify voices** also runs SpeakerKit and intentionally treats the resulting local speaker IDs as new, even if their numbers resemble the old IDs.
6. Compare the two transcript columns and play the copied recording at timestamps. Original notes are available in a separate tab and are not regenerated. The latest beta result persists across restarts; repeated runs never replace the original snapshot.
7. Confirm detected voices using existing saved people. This enrolls model-tagged native voice profiles and enables similarity-ranked suggestions on later meetings. Existing legacy profiles are retained, but cannot be compared directly with a different embedding model. Ambiguous guesses are not auto-applied. Similarity scores are not probabilities.

The beta has no automatic recording, watchers, processing resume, exports, calendar updates, Obsidian sync, or summary generation. This intentionally narrow evaluation workspace is separate from the stable UI bootstrap. It displays groups and meeting titles from the copied library. It does not yet offer incremental re-import, copying results back to stable, or a new default provider in stable.

Beta data lives under `~/Library/Application Support/MeetingNotes Beta/`; installers/builds go under `release/beta/`. The beta has a distinct bundle ID and no `meetingnotes://` registration. A failed/cancelled copy never becomes the active library. Copies require free space and reject active recording/processing. Missing audio remains unavailable rather than silently using an external live path.

## Verification and benchmarks

- `npm run build:speech` builds the pinned SpeakerKit helper; `swift test --package-path speech-engine --configuration release` checks timestamp/vector validation.
- `npm run speech:smoke` provisions the public pinned SpeakerKit files in a task-owned cache and processes generated synthetic speech. Prepare Apple's assets explicitly first. Results remain ignored under `speech-benchmark-results/`. This test is not a representative accuracy gate.
- After the short smoke, `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/speech-benchmark/long-smoke.mjs` generates a 75-minute repeated synthetic recording and checks transcription/speaker coverage throughout its timeline. This is not real-meeting accuracy evidence.
- `npm run build && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/speech-benchmark/ui-smoke.mjs` opens only a disposable synthetic profile, checks comparison/notes/audio, captures a screenshot, and cleans up its temporary library.
- `swift build --package-path scripts/speech-benchmark/parakeet --configuration release` builds an optional **benchmark-only** Parakeet adapter. FluidAudio 0.17.7 is pinned; its model loader downloads English v2 weights to an explicitly supplied task-owned directory. It is not shipped in the beta or used as fallback. Record the model cache/metadata when evaluating it; the upstream loader's model revision is not pinned by this adapter, so comparisons must not claim fully pinned Parakeet assets.

Create a local corpus manifest, never committed if it contains private information:

```json
{
  "description": "Describe the speakers, conditions and corpus limitations",
  "license": "Public fixture license or explicit local evaluation permission",
  "cases": [{ "id": "clip-1", "audio": "clip.wav", "reference": "Known reference words" }]
}
```

Run `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/speech-benchmark/compare.mjs /absolute/manifest.json`, optionally adding `--whisper=http://127.0.0.1:PORT` and `--parakeet=/absolute/path/to/parakeet-comparison`. No service is started/adopted and no meeting library is discovered. The endpoint must be loopback. Each engine runs twice and saves raw text, edit counts, reference-word counts, failures and elapsed time. A failure stays visible rather than disappearing from aggregate accuracy.

The comparison workspace remains experimental. The owner accepted their beta meeting evaluation for regular-app integration; synthetic 75-minute coverage is recorded separately. Broad accuracy, memory/overlap measurements and held-out cross-meeting identity calibration remain follow-up work, not completed benchmarks. The regular app is native-only and requires suggestion confirmation; no calibrated automatic identification claim is made. Do not advertise synthetic timing as real-meeting performance. See issue #274 and the native-speech plan for the original evaluation boundaries.

See [third-party notices](../speech-beta-notices.md) for the SDK/model terms. This work does not remove summary-runtime or media-tool requirements from stable MeetingNotes.
