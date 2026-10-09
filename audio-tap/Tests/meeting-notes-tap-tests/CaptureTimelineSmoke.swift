import Foundation
import AVFoundation
#if SWIFT_PACKAGE
@testable import meeting_notes_tap
#endif

enum CaptureTimelineSmoke {
  private struct Packet { let source: CaptureTimeline.Source; let start: Int64; let arrival: Int64; let samples: [Float] }

  /// Deliver already-converted PCM only AFTER each source packet has filled.
  /// Older fidelity tests appended before draining and could not catch the
  /// AirPods regression (4096 frames at 24kHz arrive every ~171ms).
  private static func batchedCapture(packetFrames: Int64, expectedFrames: Int64? = nil,
                                    jitter: [Int64] = [0], micStart: Int64 = 0,
                                    pause: Range<Int64>? = nil, captureMic: Bool = true,
                                    micAvailable: Bool = true, systemAvailable: Bool = true,
                                    input: [Float]? = nil)
    -> (actual: CaptureTimeline.Chunk, expected: CaptureTimeline.Chunk, timing: CaptureTimeline.Timing) {
    let count = input?.count ?? Int(packetFrames * 24)
    let duration = Int64(count)
    let voice = input ?? (0..<count).map { Float(0.2 + Double($0 % 17) / 1000) }
    let app = !systemAvailable ? [Float](repeating: 0, count: count)
      : input == nil ? [Float](repeating: -0.125, count: count)
      : (0..<count).map { Float(0.1 * sin(Double($0) * 2 * Double.pi * 660 / 48000)) }
    let timeline = CaptureTimeline(captureMic: captureMic)
    if captureMic { timeline.expectPacket(frames: expectedFrames ?? packetFrames) }
    var packets: [Packet] = []
    var expectedVoice = [Float](repeating: 0, count: count)
    if captureMic && micAvailable {
      var index = 0
      for start in stride(from: micStart, to: duration, by: Int(packetFrames)) {
        let end = min(start + packetFrames, duration)
        if pause?.contains(start) != true {
          let samples = Array(voice[Int(start)..<Int(end)])
          expectedVoice.replaceSubrange(Int(start)..<Int(end), with: samples)
          packets.append(Packet(source: .mic, start: start, arrival: end + jitter[index % jitter.count], samples: samples))
        }
        index += 1
      }
    }
    if systemAvailable {
      for start in stride(from: Int64(0), to: duration, by: 480) {
        let end = min(start + 480, duration)
        packets.append(Packet(source: .system, start: start, arrival: end + 96, samples: Array(app[Int(start)..<Int(end)])))
      }
    }
    packets.sort { $0.arrival < $1.arrival }
    var voiceOut: [Float] = [], appOut: [Float] = [], mixedOut: [Float] = []
    func collect(_ chunk: CaptureTimeline.Chunk) {
      voiceOut += chunk.mic; appOut += chunk.system; mixedOut += chunk.mixed
    }
    var nextTick: Int64 = 5760, nextPacket = 0
    while nextPacket < packets.count || nextTick <= duration {
      if nextPacket < packets.count && packets[nextPacket].arrival <= nextTick {
        let packet = packets[nextPacket]
        timeline.append(packet.samples, source: packet.source, startFrame: packet.start, arrivalFrame: packet.arrival)
        nextPacket += 1
      } else {
        while let chunk = timeline.drainReady(at: nextTick) { collect(chunk) }
        nextTick += 960
      }
    }
    while let chunk = timeline.drain(through: duration) { collect(chunk) }
    let expectedMixed = captureMic ? zip(expectedVoice, app).map { ($0 + $1) * 0.5 } : app
    return (CaptureTimeline.Chunk(mic: voiceOut, system: appOut, mixed: mixedOut),
            CaptureTimeline.Chunk(mic: expectedVoice, system: app, mixed: expectedMixed), timeline.timing)
  }

  static func batchedCallbackTests() throws {
    // 48/44.1/24/16/8kHz: 4096 source frames converted to the shared 48k clock.
    for frames: Int64 in [4096, 4459, 8192, 12288, 24576] {
      let run = batchedCapture(packetFrames: frames, jitter: [0, 240, 720, 1440])
      try AACWriterSmoke.require(run.actual.mic == run.expected.mic, "Delayed \(frames)-frame mic packets were lost, duplicated or shifted")
      try AACWriterSmoke.require(run.actual.system == run.expected.system && run.actual.mixed == run.expected.mixed, "Delayed mic altered system/mixed alignment")
      try AACWriterSmoke.require(run.timing.micLateFrames == 0 && run.timing.systemLateFrames == 0, "Supported packet timing dropped frames")
    }
    // The first actual tap buffer may be larger than the requested size.
    let larger = batchedCapture(packetFrames: 8192, expectedFrames: 4096, jitter: [720])
    try AACWriterSmoke.require(larger.actual.mic == larger.expected.mic && larger.timing.micLateFrames == 0, "Fast system input committed silence before the first larger mic buffer")
    let startup = batchedCapture(packetFrames: 8192, micStart: 12000)
    try AACWriterSmoke.require(startup.actual.mixed == startup.expected.mixed, "Mic startup moved the system stream or erased first mic samples")
    let resumed = batchedCapture(packetFrames: 8192, pause: (8192 * 8)..<(8192 * 16))
    try AACWriterSmoke.require(resumed.actual.mixed == resumed.expected.mixed, "Mic pause/resume stalled output or shifted source time")
    let micOnly = batchedCapture(packetFrames: 8192, jitter: [0, 720], systemAvailable: false)
    try AACWriterSmoke.require(micOnly.actual.mixed == micOnly.expected.mixed && micOnly.timing.micLateFrames == 0, "Delayed mic-only input could not produce an intact primary timeline")
    for micEnabled in [true, false] {
      let unavailable = batchedCapture(packetFrames: 8192, captureMic: micEnabled, micAvailable: false)
      try AACWriterSmoke.require(unavailable.actual.mixed == unavailable.expected.mixed, "Absent/disabled mic permanently stalled app capture")
    }
    let bounded = CaptureTimeline(captureMic: true)
    bounded.expectPacket(frames: 480000)
    try AACWriterSmoke.require(bounded.timing.holdbackFrames == CaptureTimeline.maximumHoldback, "Holdback exceeded its bounded budget")
    bounded.append([0.2, 0.4], source: .mic, startFrame: 0, arrivalFrame: 480001)
    while bounded.drainReady(at: 480001) != nil {}
    bounded.append([0.5, 0.5], source: .mic, startFrame: 0, arrivalFrame: 480002)
    try AACWriterSmoke.require(bounded.timing.micLateFrames == 2, "Already-written late input was replayed or not diagnosed")
    let empty = CaptureTimeline(captureMic: true)
    try AACWriterSmoke.require(empty.drainReady(at: 96000) == nil, "Timing grace manufactured audio without either input")
  }

  static func encodedBatchedMicFidelity() async throws {
    let input = (0..<196608).map { Float(0.2 * sin(Double($0) * 2 * Double.pi * 440 / 48000)) }
    let run = batchedCapture(packetFrames: 8192, expectedFrames: 4096, jitter: [0, 720, 1440], input: input)
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let format = try AACWriterSmoke.unwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false))
    var lengths: [Int64] = []
    for (name, samples, minimumRms) in [("voice", run.actual.mic, 0.08), ("system", run.actual.system, 0.05), ("mixed", run.actual.mixed, 0.04)] {
      let url = dir.appendingPathComponent("\(name).m4a")
      let writer = try AACWriter(outputURL: url, sampleRate: 48000, bitrate: 128000)
      for start in stride(from: 0, to: samples.count, by: 960) {
        let frames = min(960, samples.count - start)
        let buffer = try AACWriterSmoke.unwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)))
        buffer.frameLength = AVAudioFrameCount(frames)
        let channel = try AACWriterSmoke.unwrap(buffer.floatChannelData)[0]
        for i in 0..<frames { channel[i] = samples[start+i] }
        writer.append(buffer, at: 0)
      }
      let kept = await writer.finalize()
      try AACWriterSmoke.require(kept, "Batched \(name) stem discarded")
      let file = try AVAudioFile(forReading: url)
      let buffer = try AACWriterSmoke.unwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
      try file.read(into: buffer)
      let channel = try AACWriterSmoke.unwrap(buffer.floatChannelData)[0]
      lengths.append(file.length)
      // Ignore only codec startup/tail. Every interior 20ms speech window must
      // contain signal; average RMS alone hid the old periodic missing packets.
      for start in stride(from: 7200, to: Int(buffer.frameLength) - 8160, by: 960) {
        let rms = sqrt((0..<960).reduce(0.0) { $0 + Double(channel[start+$1] * channel[start+$1]) } / 960)
        try AACWriterSmoke.require(rms > minimumRms, "Encoded \(name) has a periodic speech dropout")
      }
    }
    try AACWriterSmoke.require(Set(lengths).count == 1 && abs(lengths[0] - Int64(input.count)) < 2500, "Batched stem finalization changed alignment or duration")
  }

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
