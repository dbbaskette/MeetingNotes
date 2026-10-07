import Foundation
import AVFoundation
#if SWIFT_PACKAGE
@testable import meeting_notes_tap
#endif

enum AACWriterSmoke {
  struct Failure: Error { let message: String }
  static func require(_ condition: Bool, _ message: String) throws { if !condition { throw Failure(message: message) } }
  static func unwrap<T>(_ value: T?) throws -> T { guard let value else { throw Failure(message: "Missing audio buffer") }; return value }
  static func emptyWriterDeletesOnlyItsOutput() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let output = dir.appendingPathComponent("empty.m4a")
    let sibling = dir.appendingPathComponent("keep.txt")
    try Data("keep".utf8).write(to: sibling)
    let writer = try AACWriter(outputURL: output, sampleRate: 48000, bitrate: 128000)
    let kept = await writer.finalize()
    try require(!kept, "Empty writer incorrectly retained output")
    try require(!FileManager.default.fileExists(atPath: output.path), "Empty output was not deleted")
    try require(FileManager.default.fileExists(atPath: sibling.path), "Sibling file was deleted")
    let keptAgain = await writer.finalize()
    try require(!keptAgain, "Repeated empty finalization changed the result")
  }

  static func nonemptyWriterKeepsReadableAudio() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let output = dir.appendingPathComponent("audio.m4a")
    let writer = try AACWriter(outputURL: output, sampleRate: 48000, bitrate: 128000)
    let format = try unwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false))
    let buffer = try unwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800))
    buffer.frameLength = 4800
    let samples = try unwrap(buffer.floatChannelData)[0]
    for i in 0..<4800 { samples[i] = 0.1 * sin(Float(i) * 0.05) }
    writer.append(buffer, at: 0)
    let kept = await writer.finalize()
    try require(kept, "Nonempty output was deleted")
    let file = try AVAudioFile(forReading: output)
    try require(file.length > 0, "Nonempty output was unreadable")
  }
}
