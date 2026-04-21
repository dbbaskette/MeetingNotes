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
    // For per-process: use the supplied PID. For system-wide: empty array
    // means "everything." The CATapDescription `processes` value uses
    // CoreAudio AudioObjectIDs that correspond to the kAudioProcess objects;
    // we look those up by PID.
    let processObjects: [AudioObjectID]
    if opts.systemAudio {
      processObjects = []
    } else if let p = opts.pid {
      guard let objID = Self.audioProcessObjectID(forPID: p) else {
        throw NSError(domain: "meeting-notes-tap", code: -2,
                      userInfo: [NSLocalizedDescriptionKey: "no audio process object for pid \(p)"])
      }
      processObjects = [objID]
    } else {
      throw NSError(domain: "meeting-notes-tap", code: -2,
                    userInfo: [NSLocalizedDescriptionKey: "no target PID and not system-audio"])
    }

    let description: CATapDescription
    if opts.systemAudio {
      // Capture all running processes — global tap excluding nothing.
      description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    } else {
      description = CATapDescription(stereoMixdownOfProcesses: processObjects)
    }
    description.uuid = UUID()
    description.name = "MeetingNotes Tap \(getpid())"
    description.isPrivate = true
    description.isExclusive = false

    var tapID: AUAudioObjectID = 0
    let s1 = AudioHardwareCreateProcessTap(description, &tapID)
    guard s1 == noErr else {
      throw NSError(domain: "meeting-notes-tap", code: Int(s1),
                    userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateProcessTap failed: \(s1)"])
    }
    self.tapObjectID = tapID

    // Wrap the tap in an aggregate device so AVAudioEngine can read it.
    let aggregateUID = "meeting-notes-tap-\(getpid())-\(UUID().uuidString)"
    let aggDescription: [String: Any] = [
      kAudioAggregateDeviceUIDKey as String: aggregateUID,
      kAudioAggregateDeviceNameKey as String: "MeetingNotes Tap Aggregate",
      kAudioAggregateDeviceIsPrivateKey as String: true,
      kAudioAggregateDeviceIsStackedKey as String: false,
      kAudioAggregateDeviceTapListKey as String: [
        [kAudioSubTapUIDKey as String: description.uuid.uuidString],
      ],
      kAudioAggregateDeviceSubDeviceListKey as String: [],
    ]
    var aggID: AudioObjectID = 0
    let s2 = AudioHardwareCreateAggregateDevice(aggDescription as CFDictionary, &aggID)
    guard s2 == noErr else {
      throw NSError(domain: "meeting-notes-tap", code: Int(s2),
                    userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateAggregateDevice failed: \(s2)"])
    }
    self.aggregateID = aggID
  }

  /// Look up the kAudioProcess AudioObjectID corresponding to a unix PID.
  private static func audioProcessObjectID(forPID pid: pid_t) -> AudioObjectID? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyProcessObjectList,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size
    )
    guard status == noErr, size > 0 else { return nil }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    status = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids
    )
    guard status == noErr else { return nil }
    for id in ids {
      var pidAddress = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyPID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      var p: pid_t = 0
      var sz = UInt32(MemoryLayout<pid_t>.size)
      let st = AudioObjectGetPropertyData(id, &pidAddress, 0, nil, &sz, &p)
      if st == noErr, p == pid { return id }
    }
    return nil
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
