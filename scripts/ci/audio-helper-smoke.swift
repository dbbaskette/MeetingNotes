import Foundation

@main enum AudioHelperSmoke {
  static func main() async throws {
    try await AACWriterSmoke.emptyWriterDeletesOnlyItsOutput()
    print("PASS: empty output cleanup, sibling preservation, repeat finalization")
    try await AACWriterSmoke.nonemptyWriterKeepsReadableAudio()
    print("PASS: nonempty output retained and readable")
  }
}
