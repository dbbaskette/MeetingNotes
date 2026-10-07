import XCTest

final class AACWriterTests: XCTestCase {
  func testEmptyWriterDeletesOnlyItsOutput() async throws {
    try await AACWriterSmoke.emptyWriterDeletesOnlyItsOutput()
  }
  func testNonemptyWriterKeepsReadableAudio() async throws {
    try await AACWriterSmoke.nonemptyWriterKeepsReadableAudio()
  }
}
