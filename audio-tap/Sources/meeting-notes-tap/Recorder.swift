import AVFoundation
import AudioToolbox
import CoreAudio

// Owns the lifecycle of one recording: tap + mic + mix + write.
final class Recorder {
  private let opts: RecordOptions
  private var writer: AACWriter?
  private var engine: AVAudioEngine?
  private var micEngine: AVAudioEngine?
  private var tapObjectID: AudioObjectID = 0
  private var aggregateID: AudioObjectID = 0
  private var lastSignalAt: Date = .init()
  private var lastLevelEmitAt: TimeInterval = 0
  private var stopped = false

  init(opts: RecordOptions) { self.opts = opts }

  func start() throws {
    let url = URL(fileURLWithPath: opts.outputPath)
    // Use 48 kHz to match what aggregate devices typically expose.
    writer = try AACWriter(outputURL: url, sampleRate: 48_000, bitrate: 128_000)
    try attachProcessTap()
    if opts.captureMic { try attachMic() }
    try startEngine()
    StatusEvent.emit(["event": "started"])
  }

  func stop() async {
    guard !stopped else { return }
    stopped = true
    engine?.stop()
    micEngine?.stop()
    detachProcessTap()
    if let w = writer {
      await w.finalize()
      StatusEvent.emit([
        "event": "stopped",
        "bytes": NSNumber(value: w.bytesWritten),
      ])
    }
  }

  func lastSignalSeen() -> Date { lastSignalAt }

  // MARK: - Process Tap
  private func attachProcessTap() throws {
    // Stub — implemented in Task 7.
    throw NSError(domain: "meeting-notes-tap", code: -1,
                  userInfo: [NSLocalizedDescriptionKey: "Process tap attach not yet implemented (Task 7)"])
  }

  private func detachProcessTap() {
    if tapObjectID != 0 { _ = AudioHardwareDestroyProcessTap(tapObjectID); tapObjectID = 0 }
    if aggregateID != 0 { _ = AudioHardwareDestroyAggregateDevice(aggregateID); aggregateID = 0 }
  }

  // MARK: - Mic
  private func attachMic() throws {
    // Implemented in Task 8/9.
  }

  // MARK: - Engine
  private func startEngine() throws {
    // Implemented in Task 8.
  }
}
