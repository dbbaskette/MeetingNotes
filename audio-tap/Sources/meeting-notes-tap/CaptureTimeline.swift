import Foundation

/// Two bounded timestamped PCM rings on one 48 kHz timeline. Neither input
/// clock drives output: missing callbacks become silence, not missing time.
/// Callers copy converted PCM while the audio callback still owns it.
final class CaptureTimeline {
  enum Source { case mic, system }
  struct Chunk { let mic: [Float]; let system: [Float]; let mixed: [Float] }
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

  init(captureMic: Bool, capacity: Int = 96_000) {
    self.captureMic = captureMic
    self.capacity = capacity
    mic = .init(repeating: 0, count: capacity)
    system = .init(repeating: 0, count: capacity)
    micIndex = .init(repeating: -1, count: capacity)
    systemIndex = .init(repeating: -1, count: capacity)
  }

  func append(_ samples: [Float], source: Source, startFrame: Int64) {
    lock.lock(); defer { lock.unlock() }
    guard !samples.isEmpty else { return }
    for (offset, sample) in samples.enumerated() {
      let frame = startFrame + Int64(offset)
      // Drop obsolete/out-of-window packets without growing memory or
      // inserting them at a different time. Later source resumption is exact.
      guard frame >= max(cursor, clock - Int64(capacity)), frame < max(cursor, clock) + Int64(capacity) else { continue }
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
    clock = max(clock, endFrame)
    guard received, endFrame > cursor else { return nil }
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
}
