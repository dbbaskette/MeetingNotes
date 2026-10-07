import Foundation
import AVFoundation
#if SWIFT_PACKAGE
@testable import meeting_notes_tap
#endif

enum CaptureTimelineSmoke {
  static func gapAndSourceTests() throws {
    let require = AACWriterSmoke.require
    let t = CaptureTimeline(captureMic: true, capacity: 32)
    try require(t.drain(through: 8) == nil, "No inputs must not manufacture an audio file")
    t.append([0.2, 0.4, 0.6, 0.8], source: .mic, startFrame: 0)
    let first = try AACWriterSmoke.unwrap(t.drain(through: 8))
    try require(first.mic == [0.2, 0.4, 0.6, 0.8, 0, 0, 0, 0], "Mic samples/timeline were changed")
    try require(first.mixed == first.mic.map { $0 * 0.5 }, "Silent app prevented mic mixing")
    t.append([0.4, 0.4], source: .system, startFrame: 10)
    t.append([0.2, 0.2], source: .mic, startFrame: 10)
    let second = try AACWriterSmoke.unwrap(t.drain(through: 12))
    try require(second.mixed == [0, 0, 0.3, 0.3], "Source resume shifted or duplicated samples")
    t.append([1, 1], source: .mic, startFrame: 0) // stale, never replay
    t.append([Float.nan, Float.infinity, 3, -3], source: .system, startFrame: 12)
    let sanitized = try AACWriterSmoke.unwrap(t.drain(through: 16))
    try require(sanitized.mixed == [0, 0, 0.5, -0.5], "Invalid samples/clipping were not bounded")
    let app = CaptureTimeline(captureMic: false)
    app.append([0.2, 0.4], source: .system, startFrame: 0)
    try require(app.drain(through: 2)?.mixed == [0.2, 0.4], "No-mic system output was attenuated")
    let delayed = CaptureTimeline(captureMic: true, capacity: 32)
    try require(delayed.drain(through: 128) == nil, "Startup silence manufactured a file")
    delayed.append([0.2, 0.4], source: .mic, startFrame: 128)
    var startup: [Float] = []
    while let chunk = delayed.drain(through: 130, maxFrames: 16) { startup += chunk.mixed }
    try require(startup.count == 130 && startup.suffix(2) == [0.1, 0.2], "Long startup silence permanently blocked new input or shifted time")
    // Out-of-window/old packets are discarded rather than unbounded backlog.
    t.append([1], source: .mic, startFrame: 1000)
    try require(t.drain(through: 1000, maxFrames: 4)?.mixed == [0, 0, 0, 0], "Output chunk was unbounded")
  }

  static func encodedMicFidelity(speechURL: URL? = nil) async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let timeline = CaptureTimeline(captureMic: true)
    var inputSamples: [Float] = []
    for frame in 0..<48000 {
      let phase = Double(frame) * 2.0 * Double.pi * 440.0 / 48000.0
      inputSamples.append(Float(0.2 * sin(phase)))
    }
    if let speechURL {
      let file = try AVAudioFile(forReading: speechURL)
      try AACWriterSmoke.require(file.processingFormat.sampleRate == 48000 && file.processingFormat.channelCount == 1, "Speech fixture must be mono 48kHz")
      let buffer = try AACWriterSmoke.unwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
      try file.read(into: buffer)
      inputSamples = Array(UnsafeBufferPointer(start: try AACWriterSmoke.unwrap(buffer.floatChannelData)[0], count: Int(buffer.frameLength)))
      let peak = inputSamples.map(abs).max() ?? 0
      try AACWriterSmoke.require(peak > 0.01, "Speech fixture is silent")
      inputSamples = inputSamples.map { $0 * 0.2 / peak }
    }
    let inputRms = sqrt(inputSamples.reduce(0) { $0 + Double($1 * $1) } / Double(inputSamples.count))
    let format = try AACWriterSmoke.unwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false))
    let voiceURL = dir.appendingPathComponent("voice.m4a"), mixedURL = dir.appendingPathComponent("mixed.m4a")
    let voice = try AACWriter(outputURL: voiceURL, sampleRate: 48000, bitrate: 128000)
    let mixed = try AACWriter(outputURL: mixedURL, sampleRate: 48000, bitrate: 128000)
    for start in stride(from: 0, to: inputSamples.count, by: 4800) {
      let samples = Array(inputSamples[start..<min(start + 4800, inputSamples.count)])
      timeline.append(samples, source: .mic, startFrame: Int64(start))
      let chunk = try AACWriterSmoke.unwrap(timeline.drain(through: Int64(start + samples.count)))
      for (writer, pcm) in [(voice, chunk.mic), (mixed, chunk.mixed)] {
        let b = try AACWriterSmoke.unwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800))
        b.frameLength = AVAudioFrameCount(samples.count)
        let channel = try AACWriterSmoke.unwrap(b.floatChannelData)[0]
        for i in 0..<samples.count { channel[i] = pcm[i] }
        writer.append(b, at: 0)
      }
    }
    let voiceKept = await voice.finalize(), mixedKept = await mixed.finalize()
    try AACWriterSmoke.require(voiceKept && mixedKept, "Mic-only output was discarded")
    func decoded(_ url: URL) throws -> (Double, Float, Int64) {
      let file = try AVAudioFile(forReading: url)
      let b = try AACWriterSmoke.unwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
      try file.read(into: b)
      let channel = try AACWriterSmoke.unwrap(b.floatChannelData)[0]
      let samples = Array(UnsafeBufferPointer(start: channel, count: Int(b.frameLength)))
      let rms = sqrt(samples.reduce(0) { $0 + Double($1 * $1) } / Double(samples.count))
      return (rms, samples.map(abs).max() ?? 0, file.length)
    }
    let v = try decoded(voiceURL), m = try decoded(mixedURL)
    try AACWriterSmoke.require(v.0 / inputRms > 0.85 && v.0 / inputRms < 1.15, "Voice encoding changed source signal into noise/silence")
    try AACWriterSmoke.require(v.1 < 0.3 && m.1 < 0.2, "Encoder introduced clipping spikes")
    try AACWriterSmoke.require(m.0 / v.0 > 0.45 && m.0 / v.0 < 0.55, "Mixed mic gain/content does not match voice stem")
    try AACWriterSmoke.require(abs(v.2 - Int64(inputSamples.count)) < 2500 && v.2 == m.2, "Stem duration/timeline diverged")
  }
}
