import XCTest

final class AACWriterTests: XCTestCase {
  func testEmptyWriterDeletesOnlyItsOutput() async throws {
    try await AACWriterSmoke.emptyWriterDeletesOnlyItsOutput()
  }
  func testNonemptyWriterKeepsReadableAudio() async throws {
    try await AACWriterSmoke.nonemptyWriterKeepsReadableAudio()
  }
  func testCaptureTimelineGapsAndSources() throws { try CaptureTimelineSmoke.gapAndSourceTests() }
  func testEncodedMicFidelity() async throws { try await CaptureTimelineSmoke.encodedMicFidelity() }
}
