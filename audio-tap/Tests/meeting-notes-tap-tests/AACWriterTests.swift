import XCTest

final class AACWriterTests: XCTestCase {
  func testEmptyWriterDeletesOnlyItsOutput() async throws {
    try await AACWriterSmoke.emptyWriterDeletesOnlyItsOutput()
  }
  func testNonemptyWriterKeepsReadableAudio() async throws {
    try await AACWriterSmoke.nonemptyWriterKeepsReadableAudio()
  }
  func testCaptureTimelineGapsAndSources() throws { try CaptureTimelineSmoke.gapAndSourceTests() }
  func testBatchedMicrophoneCallbacks() throws { try CaptureTimelineSmoke.batchedCallbackTests() }
  func testEncodedBatchedMicFidelity() async throws { try await CaptureTimelineSmoke.encodedBatchedMicFidelity() }
  func testEncodedMicFidelity() async throws { try await CaptureTimelineSmoke.encodedMicFidelity() }
}
