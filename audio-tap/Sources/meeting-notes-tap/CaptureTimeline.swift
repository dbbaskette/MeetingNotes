import Foundation

/// Two bounded timestamped PCM rings on one 48 kHz timeline. Neither input
/// clock drives output: missing callbacks become silence, not missing time.
/// Callers copy converted PCM while the audio callback still owns it.
final class CaptureTimeline {
  enum Source { case mic, system }
  struct Chunk { let mic: [Float]; let system: [Float]; let mixed: [Float] }
  struct Timing { let holdbackFrames: Int64; let micLateFrames: Int64; let systemLateFrames: Int64 }
  static let sampleRate: Double = 48_000
  private static let minimumHoldback: Int64 = 5760 // 120ms for small input packets.
  private static let deliveryMargin: Int64 = 2880 // 60ms beyond observed packet age.
  static let maximumHoldback: Int64 = 48_000 // One second, within the two-second ring.
  private let lock = NSLock()
  private let capacity: Int
  private let captureMic: Bool
  private var mic: [Float]
  private var system: [Float]
  private var micIndex: [Int64]
  private var systemIndex: [Int64]
  private var cursor: Int64 = 0
  private var clock: Int64 = 0
  private var received = false
  private var lastInputEnd: Int64 = 0
  private var holdbackFrames = CaptureTimeline.minimumHoldback
  private var micObserved = false
  private var micLateFrames: Int64 = 0
  private var systemLateFrames: Int64 = 0

  init(captureMic: Bool, capacity: Int = 96_000) {
    self.captureMic = captureMic
    self.capacity = capacity
    mic = .init(repeating: 0, count: capacity)
    system = .init(repeating: 0, count: capacity)
    micIndex = .init(repeating: -1, count: capacity)
    systemIndex = .init(repeating: -1, count: capacity)
  }

  /// Seed before starting the output clock. 4096 input frames at 24kHz are
  /// 8192 output frames / 171ms, not the 85ms assumed by a fixed 120ms delay.
  func expectPacket(frames: Int64) {
    lock.lock(); defer { lock.unlock() }
    extendHoldback(for: frames)
  }

  private func extendHoldback(for age: Int64) {
    let boundedAge = max(0, min(age, Self.maximumHoldback))
    holdbackFrames = max(holdbackFrames, min(Self.maximumHoldback, boundedAge + Self.deliveryMargin))
  }

  func append(_ samples: [Float], source: Source, startFrame: Int64, arrivalFrame: Int64? = nil) {
    lock.lock(); defer { lock.unlock() }
    guard !samples.isEmpty else { return }
    if source == .mic { micObserved = true }
    // AVAudioEngine can deliver a different frame count than installTap
    // requested. Observe the age of the *start* of each converted packet,
    // including conversion/delivery latency, before making it drainable.
    if let arrivalFrame {
      extendHoldback(for: max(Int64(samples.count), max(0, arrivalFrame - startFrame)))
    }
    for (offset, sample) in samples.enumerated() {
      let frame = startFrame + Int64(offset)
      // Drop obsolete/out-of-window packets without growing memory or
      // inserting them at a different time. Later source resumption is exact.
      if frame < cursor {
        if source == .mic { micLateFrames += 1 } else { systemLateFrames += 1 }
        continue
      }
      guard frame >= clock - Int64(capacity), frame < max(cursor, clock) + Int64(capacity) else { continue }
      received = true
      lastInputEnd = max(lastInputEnd, frame + 1)
      let slot = Int(frame % Int64(capacity))
      let value = sample.isFinite ? max(-1, min(1, sample)) : 0
      switch source {
      case .mic: mic[slot] = value; micIndex[slot] = frame
      case .system: system[slot] = value; systemIndex[slot] = frame
      }
    }
  }

  func drain(through endFrame: Int64, maxFrames: Int = 4800) -> Chunk? {
    lock.lock(); defer { lock.unlock() }
    return drainLocked(through: endFrame, maxFrames: maxFrames)
  }

  /// Live output uses packet-aware holdback. Stop can still drain through the
  /// exact capture end after callbacks have stopped. A missing source never
  /// stalls the other forever; silence and source resumption retain wall time.
  func drainReady(at wallFrame: Int64, maxFrames: Int = 4800) -> Chunk? {
    lock.lock(); defer { lock.unlock() }
    // Do not let fast system callbacks commit silence before learning the
    // first actual microphone packet size. Absent mic remains bounded to 1s.
    if captureMic && !micObserved && wallFrame < Self.maximumHoldback { return nil }
    return drainLocked(through: wallFrame - holdbackFrames, maxFrames: maxFrames)
  }

  private func drainLocked(through endFrame: Int64, maxFrames: Int) -> Chunk? {
    clock = max(clock, endFrame)
    guard received, endFrame > cursor, maxFrames > 0 else { return nil }
    let count = Int(min(endFrame - cursor, Int64(maxFrames)))
    var voice = [Float](repeating: 0, count: count)
    var app = voice
    var mixed = voice
    for i in 0..<count {
      let frame = cursor + Int64(i)
      let slot = Int(frame % Int64(capacity))
      voice[i] = micIndex[slot] == frame ? mic[slot] : 0
      app[i] = systemIndex[slot] == frame ? system[slot] : 0
      mixed[i] = captureMic ? (voice[i] + app[i]) * 0.5 : app[i]
    }
    cursor += Int64(count)
    return Chunk(mic: voice, system: app, mixed: mixed)
  }

  var inputEnd: Int64 { lock.lock(); defer { lock.unlock() }; return lastInputEnd }
  var timing: Timing {
    lock.lock(); defer { lock.unlock() }
    return Timing(holdbackFrames: holdbackFrames, micLateFrames: micLateFrames, systemLateFrames: systemLateFrames)
  }
}
