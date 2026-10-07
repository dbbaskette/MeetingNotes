import XCTest
import AVFoundation
@testable import meeting_notes_tap

final class AACWriterTests: XCTestCase {
  func testEmptyWriterDeletesOnlyItsOutput() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let output = dir.appendingPathComponent("empty.m4a")
    let sibling = dir.appendingPathComponent("keep.txt")
    try Data("keep".utf8).write(to: sibling)
    let writer = try AACWriter(outputURL: output, sampleRate: 48000, bitrate: 128000)
    let kept = await writer.finalize()
    XCTAssertFalse(kept)
    XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: sibling.path))
    let keptAgain = await writer.finalize()
    XCTAssertFalse(keptAgain)
  }

  func testNonemptyWriterKeepsReadableAudio() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let output = dir.appendingPathComponent("audio.m4a")
    let writer = try AACWriter(outputURL: output, sampleRate: 48000, bitrate: 128000)
    let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false))
    let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800))
    buffer.frameLength = 4800
    let samples = try XCTUnwrap(buffer.floatChannelData)[0]
    for i in 0..<4800 { samples[i] = 0.1 * sin(Float(i) * 0.05) }
    writer.append(buffer, at: 0)
    let kept = await writer.finalize()
    XCTAssertTrue(kept)
    let file = try AVAudioFile(forReading: output)
    XCTAssertGreaterThan(file.length, 0)
  }
}
