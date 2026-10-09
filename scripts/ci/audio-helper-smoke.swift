import Foundation

@main enum AudioHelperSmoke {
  static func main() async throws {
    try await AACWriterSmoke.emptyWriterDeletesOnlyItsOutput()
    print("PASS: empty output cleanup, sibling preservation, repeat finalization")
    try await AACWriterSmoke.nonemptyWriterKeepsReadableAudio()
    print("PASS: nonempty output retained and readable")
    try CaptureTimelineSmoke.gapAndSourceTests()
    print("PASS: mic/system/dual source timeline, gaps, resumption, finite bounded samples")
    try CaptureTimelineSmoke.batchedCallbackTests()
    print("PASS: delayed 48/44.1/24/16/8kHz mic packets, actual buffer sizes, jitter, startup, pause/resume, bounded holdback")
    try await CaptureTimelineSmoke.encodedBatchedMicFidelity()
    print("PASS: encoded batched mic/dual-source speech has no periodic dropout; stems/finalization aligned")
    try await CaptureTimelineSmoke.encodedMicFidelity()
    print("PASS: decoded mic-only primary/voice fidelity, gain, clipping and aligned duration")
    if let file = ProcessInfo.processInfo.environment["MN_AUDIO_SPEECH_FIXTURE"] {
      try await CaptureTimelineSmoke.encodedMicFidelity(speechURL: URL(fileURLWithPath: file))
      print("PASS: decoded synthetic speech primary/voice RMS, gain, clipping and aligned duration")
    }
  }
}
