# Native speech full-app integration verification

Target: 1.15.0, integrating the owner's accepted Apple/SpeakerKit comparison beta into the regular app. Final verification and artifact identities are recorded here before publication.

The [beta verification report](2026-10-16-native-speech-beta-verification.md) covers the unchanged native engine implementation, anonymous pinned model download/offline inference, synthetic 75-minute coverage and comparison-workspace isolation. This integration adds full-app routing, provider selection/recovery, model-isolated stable voice profiles, native setup, terminology compatibility and packaging.

## Scope and safety

- No private meetings or signed-in exporter accounts are used by automated tests.
- The installed app and its active recording/processing are not replaced or interrupted.
- Existing users remain on their provider until opting in. Native similarities require confirmation. Legacy vectors and old meeting artifacts remain untouched by switching.
- Synthetic full-pipeline checks use actual Apple/SpeakerKit inference but deterministic LLM responses. They do not establish real-LLM quality, live microphone capture, overlap accuracy, held-out identity calibration or signed-in export acceptance.
- Local installer signing uses Apple Development, not notarized Developer ID distribution. GitHub releases have no installer assets.

## Results

Pending final committed-tree local CI, physical integration smoke, and signed artifact verification.
