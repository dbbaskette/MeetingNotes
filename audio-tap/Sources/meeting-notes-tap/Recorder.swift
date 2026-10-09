import AVFoundation
import AudioToolbox
import CoreAudio

// Owns the lifecycle of one recording: tap + mic + mix + write.
final class Recorder {
  private let opts: RecordOptions
  // Three writers:
  //   writerMixed — 50/50 mic + tap mono, same file we've always produced.
  //                 The library watcher / pipeline consumes this; it's the
  //                 "primary" recording.
  //   writerVoice — mic-only stem (omitted when captureMic == false).
  //   writerSystem — tap-only stem (the other side of the conversation).
  // Stems are sidecar files — <mixed>.voice.m4a and <mixed>.system.m4a —
  // written alongside the mixed output. A future pipeline pass can
  // transcribe each stem independently for deterministic speaker-ID and
  // better overlap handling; today they're just artifacts on disk.
  private var writerMixed: AACWriter?
  private var writerVoice: AACWriter?
  private var writerSystem: AACWriter?
  private var engine: AVAudioEngine?
  private var micEngine: AVAudioEngine?
  private var tapObjectID: AudioObjectID = 0
  private var aggregateID: AudioObjectID = 0
  private var ioProcID: AudioDeviceIOProcID?
  private var aggregateRunning = false
  private var tapFormat: AudioStreamBasicDescription = AudioStreamBasicDescription()
  private let writeFormat: AVAudioFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: 48_000,
    channels: 1,
    interleaved: false
  )!
  private var converter: AVAudioConverter?
  private var sourceFormat: AVAudioFormat?
  private let timeline: CaptureTimeline
  private let mixQueue = DispatchQueue(label: "MeetingNotes.capture-clock")
  private var mixTimer: DispatchSourceTimer?
  private var originSeconds: Double = 0
  private var lastSignalAt: Date = .init()
  private var lastLevelEmitAt: [String: TimeInterval] = [:]
  private let levelLock = NSLock()
  private let timingLock = NSLock()
  private var lastTimingEmitFrame: [String: Int64] = [:]
  private var stopTask: Task<Void, Never>?
  private let stopLock = NSLock()
  // Task 12 diagnostics: count IOProc invocations to detect "no data flow"
  // even when AudioDeviceStart succeeds.
  private var ioProcFireCount: UInt64 = 0
  private var diagTimer: DispatchSourceTimer?

  init(opts: RecordOptions) { self.opts = opts; timeline = CaptureTimeline(captureMic: opts.captureMic) }

  func start() throws {
    let mixedURL = URL(fileURLWithPath: opts.outputPath)
    // Use 48 kHz to match what aggregate devices typically expose.
    writerMixed = try AACWriter(outputURL: mixedURL, sampleRate: 48_000, bitrate: 128_000)
    // Stems: <mixed>.voice.m4a (mic) and <mixed>.system.m4a (tap). Sidecar
    // the mixed file so the library watcher picks up exactly one meeting
    // per recording; stems are filtered out watcher-side by filename.
    let baseURL = mixedURL.deletingPathExtension()
    let voiceURL = baseURL.appendingPathExtension("voice").appendingPathExtension("m4a")
    let systemURL = baseURL.appendingPathExtension("system").appendingPathExtension("m4a")
    if opts.captureMic {
      writerVoice = try AACWriter(outputURL: voiceURL, sampleRate: 48_000, bitrate: 128_000)
    }
    writerSystem = try AACWriter(outputURL: systemURL, sampleRate: 48_000, bitrate: 128_000)
    try attachProcessTap()
    watchTargetPIDIfNeeded()
    if opts.captureMic { try attachMic() }
    originSeconds = AVAudioTime.seconds(forHostTime: mach_absolute_time())
    try startEngine()
    startMixClock()
    StatusEvent.emit([
      "event": "started",
      "output_mixed": opts.outputPath,
      "output_voice": opts.captureMic ? voiceURL.path : "",
      "output_system": systemURL.path,
    ])
  }

  // MARK: - Target PID watcher (Task 11)
  // When the user's recording targets a specific PID, watch it via kqueue
  // and auto-finalize the recording when that process exits.
  private func watchTargetPIDIfNeeded() {
    guard let targetPID = opts.pid else { return }
    DispatchQueue.global().async { [weak self] in
      let kq = kqueue()
      guard kq >= 0 else { return }
      var event = kevent(
        ident: UInt(targetPID), filter: Int16(EVFILT_PROC),
        flags: UInt16(EV_ADD | EV_ENABLE | EV_ONESHOT),
        fflags: UInt32(NOTE_EXIT), data: 0, udata: nil
      )
      _ = kevent(kq, &event, 1, nil, 0, nil)
      var triggered = kevent()
      _ = kevent(kq, nil, 0, &triggered, 1, nil)
      close(kq)
      Task {
        StatusEvent.emit(["event": "target_exited", "pid": Int(targetPID)])
        await self?.stop()
        exit(0)
      }
    }
  }

  func stop() async {
    let task = stopLock.withLock { () -> Task<Void, Never> in
      if let pending = stopTask { return pending }
      let pending = Task { await self.finishStop() }
      stopTask = pending
      return pending
    }
    await task.value
  }

  private func finishStop() async {
    stopAggregateIO()
    engine?.stop()
    mixTimer?.cancel(); mixTimer = nil
    // Stop inputs first, then drain the bounded ring on its single output
    // queue. No callback can race encoder finalization or truncate the tail.
    mixQueue.sync {
      let end = max(timeline.inputEnd, currentFrame())
      while let chunk = timeline.drain(through: end) { writeChunk(chunk) }
    }
    let timing = timeline.timing
    StatusEvent.emit([
      "event": "diag", "stage": "capture_timing_stop",
      "holdback_ms": Double(timing.holdbackFrames) / 48,
      "mic_late_frames": NSNumber(value: timing.micLateFrames),
      "system_late_frames": NSNumber(value: timing.systemLateFrames),
    ])
    detachProcessTap()
    // Finalize all three writers. Await each so the encoders flush cleanly;
    // the queue.sync inside AACWriter makes the cost additive but still
    // bounded (sub-second each). A writer that never received audio deletes
    // its file (see AACWriter.finalize) so no unreadable stubs survive.
    var dropped: [String] = []
    if let w = writerMixed, await !w.finalize() { dropped.append("mixed") }
    if let w = writerVoice, await !w.finalize() { dropped.append("voice") }
    if let w = writerSystem, await !w.finalize() { dropped.append("system") }
    StatusEvent.emit([
      "event": "stopped",
      "bytes": NSNumber(value: writerMixed?.bytesWritten ?? 0),
      "bytes_voice": NSNumber(value: writerVoice?.bytesWritten ?? 0),
      "bytes_system": NSNumber(value: writerSystem?.bytesWritten ?? 0),
      "empty_stems_deleted": dropped,
    ])
  }

  func lastSignalSeen() -> Date { levelLock.withLock { lastSignalAt } }

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
    description.muteBehavior = .unmuted

    var tapID: AUAudioObjectID = 0
    let s1 = AudioHardwareCreateProcessTap(description, &tapID)
    guard s1 == noErr else {
      throw NSError(domain: "meeting-notes-tap", code: Int(s1),
                    userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateProcessTap failed: \(s1)"])
    }
    self.tapObjectID = tapID

    // Aggregate device must include the system default output as the main
    // sub-device — otherwise `kAudioDevicePropertyDeviceIsRunning` stays 0
    // and the IOProc never fires. The tap is an *additional* stream on top.
    // (Pattern matches AudioCap's ProcessTap.swift.)
    let outputUID: String
    do {
      let outputID = try Self.readDefaultSystemOutputDeviceID()
      outputUID = try Self.readDeviceUID(outputID)
    } catch {
      throw NSError(domain: "meeting-notes-tap", code: -11,
                    userInfo: [NSLocalizedDescriptionKey: "could not read default output device: \(error)"])
    }

    let aggregateUID = UUID().uuidString
    let tapUIDString = description.uuid.uuidString
    let aggDescription: [String: Any] = [
      kAudioAggregateDeviceNameKey as String: "MeetingNotes Tap \(getpid())",
      kAudioAggregateDeviceUIDKey as String: aggregateUID,
      kAudioAggregateDeviceMainSubDeviceKey as String: outputUID,
      kAudioAggregateDeviceIsPrivateKey as String: true,
      kAudioAggregateDeviceIsStackedKey as String: false,
      kAudioAggregateDeviceTapAutoStartKey as String: true,
      kAudioAggregateDeviceSubDeviceListKey as String: [
        [ kAudioSubDeviceUIDKey as String: outputUID ],
      ],
      kAudioAggregateDeviceTapListKey as String: [
        [
          kAudioSubTapDriftCompensationKey as String: true,
          kAudioSubTapUIDKey as String: tapUIDString,
        ],
      ],
    ]
    var aggID: AudioObjectID = 0
    let s2 = AudioHardwareCreateAggregateDevice(aggDescription as CFDictionary, &aggID)
    guard s2 == noErr else {
      throw NSError(domain: "meeting-notes-tap", code: Int(s2),
                    userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateAggregateDevice failed: \(s2)"])
    }
    self.aggregateID = aggID
  }

  // MARK: - CoreAudio helpers (adapted from AudioCap's CoreAudioUtils.swift)

  /// Read `kAudioHardwarePropertyDefaultSystemOutputDevice` from the system object.
  private static func readDefaultSystemOutputDeviceID() throws -> AudioObjectID {
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var devID: AudioObjectID = 0
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let st = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &devID
    )
    guard st == noErr, devID != 0 else {
      throw NSError(domain: "meeting-notes-tap", code: Int(st),
                    userInfo: [NSLocalizedDescriptionKey: "default output device read failed: \(st)"])
    }
    return devID
  }

  /// Read `kAudioDevicePropertyDeviceUID` for the given device object ID.
  private static func readDeviceUID(_ devID: AudioObjectID) throws -> String {
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyDeviceUID,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var uid: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString?>.size)
    let st = withUnsafeMutablePointer(to: &uid) { ptr in
      AudioObjectGetPropertyData(devID, &addr, 0, nil, &size, ptr)
    }
    guard st == noErr else {
      throw NSError(domain: "meeting-notes-tap", code: Int(st),
                    userInfo: [NSLocalizedDescriptionKey: "device UID read failed: \(st)"])
    }
    return uid as String
  }

  /// Look up the kAudioProcess AudioObjectID corresponding to a unix PID via
  /// `kAudioHardwarePropertyTranslatePIDToProcessObject` (AudioCap pattern).
  private static func audioProcessObjectID(forPID pid: pid_t) -> AudioObjectID? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var inPID: pid_t = pid
    var objectID: AudioObjectID = 0
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let qualSize = UInt32(MemoryLayout<pid_t>.size)
    let st = withUnsafeMutablePointer(to: &inPID) { qPtr -> OSStatus in
      AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address, qualSize, qPtr, &size, &objectID
      )
    }
    guard st == noErr, objectID != 0 else { return nil }
    return objectID
  }

  private func detachProcessTap() {
    if tapObjectID != 0 { _ = AudioHardwareDestroyProcessTap(tapObjectID); tapObjectID = 0 }
    if aggregateID != 0 { _ = AudioHardwareDestroyAggregateDevice(aggregateID); aggregateID = 0 }
  }

  // MARK: - Mic
  private func attachMic() throws {
    // The mic is captured via a second AVAudioEngine in startEngine(); no
    // separate setup needed here.
  }

  // MARK: - Engine
  // SUBSTITUTION FROM PLAN: the spec wired AVAudioEngine.inputNode to the
  // aggregate device, but in practice AVAudioEngine drops Process Tap data
  // (input always reads as 1ch silence). Use the documented CoreAudio
  // IOProc on the aggregate device directly — that's the path the WWDC
  // sample uses too.
  private func startEngine() throws {
    // Read the tap's actual format from the tap object itself
    // (kAudioTapPropertyFormat) — this is the authoritative format the
    // captured audio is delivered in.
    var streamFormat = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    var tapFmtAddr = AudioObjectPropertyAddress(
      mSelector: kAudioTapPropertyFormat,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    let sf = AudioObjectGetPropertyData(tapObjectID, &tapFmtAddr, 0, nil, &size, &streamFormat)
    guard sf == noErr, streamFormat.mSampleRate > 0 else {
      throw NSError(domain: "meeting-notes-tap", code: Int(sf),
                    userInfo: [NSLocalizedDescriptionKey: "read tap stream format failed: \(sf)"])
    }
    self.tapFormat = streamFormat
    // Tap reports its native rate via kAudioTapPropertyFormat, but the
    // AGGREGATE device resamples tap data to its own clock before delivering
    // it through the IOProc. If the user's default output device runs at
    // 96k (Bluetooth / some USB interfaces / certain virtual drivers),
    // tap data arrives at 96k while the code thinks it's 48k — so every
    // 512-frame ABL is written as if it were 48k, playback sounds 2× fast
    // (chipmunks). Override the source rate with the aggregate's actual
    // nominal rate.
    var nominalRate: Float64 = 0
    var nrSize = UInt32(MemoryLayout<Float64>.size)
    var nrAddr = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyNominalSampleRate,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    let nrStatus = AudioObjectGetPropertyData(aggregateID, &nrAddr, 0, nil, &nrSize, &nominalRate)
    let deliveredRate: Float64 = (nrStatus == noErr && nominalRate > 0) ? nominalRate : streamFormat.mSampleRate
    if deliveredRate != streamFormat.mSampleRate {
      streamFormat.mSampleRate = deliveredRate
    }
    StatusEvent.emit([
      "event": "diag",
      "stage": "tap_format",
      "tap_sr": self.tapFormat.mSampleRate,
      "agg_sr": deliveredRate,
      "sr": streamFormat.mSampleRate,
      "ch": Int(streamFormat.mChannelsPerFrame),
      "bits": Int(streamFormat.mBitsPerChannel),
      "bytes_per_frame": Int(streamFormat.mBytesPerFrame),
      "fmt_flags": Int(streamFormat.mFormatFlags),
    ])

    // Build the source AVAudioFormat directly from the stream description so
    // interleaved-ness matches what CoreAudio actually delivers (the IOProc
    // ABL with mNumberBuffers==1 + multi-channel is interleaved).
    guard let src = AVAudioFormat(streamDescription: &streamFormat) else {
      throw NSError(domain: "meeting-notes-tap", code: -10,
                    userInfo: [NSLocalizedDescriptionKey: "could not build source AVAudioFormat"])
    }
    self.sourceFormat = src
    self.converter = AVAudioConverter(from: src, to: writeFormat)

    var procID: AudioDeviceIOProcID?
    let unmanaged = Unmanaged.passUnretained(self).toOpaque()
    let ioQueue = DispatchQueue(label: "meeting-notes-tap.ioproc", qos: .userInteractive)
    // SUBSTITUTION: Some macOS 14.2+ builds will not invoke the IOProc on
    // the aggregate device wrapping a tap (DeviceIsRunning stays 0 even
    // after Start). Try the tap object's own IOProc as a fallback.
    let cs = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, ioQueue) {
      (_, inInputData, inInputTime, _, _) -> Void in
      let recorder = Unmanaged<Recorder>.fromOpaque(unmanaged).takeUnretainedValue()
      recorder.handleIOProc(inputData: inInputData, inputTime: inInputTime)
    }
    guard cs == noErr, let pid = procID else {
      throw NSError(domain: "meeting-notes-tap", code: Int(cs),
                    userInfo: [NSLocalizedDescriptionKey: "AudioDeviceCreateIOProcID failed: \(cs)"])
    }
    self.ioProcID = pid
    let ss = AudioDeviceStart(aggregateID, pid)
    guard ss == noErr else {
      throw NSError(domain: "meeting-notes-tap", code: Int(ss),
                    userInfo: [NSLocalizedDescriptionKey: "AudioDeviceStart failed: \(ss)"])
    }
    aggregateRunning = true

    // Task 12 diagnostics: probe DeviceIsRunning + IOProc fire count once a
    // second so we can tell from logs whether the tap is delivering data.
    var runAddr = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyDeviceIsRunning,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var running: UInt32 = 0
    var rsz = UInt32(MemoryLayout<UInt32>.size)
    let _ = AudioObjectGetPropertyData(aggregateID, &runAddr, 0, nil, &rsz, &running)
    StatusEvent.emit([
      "event": "diag",
      "stage": "after_start",
      "device_is_running": Int(running),
      "agg_id": Int(aggregateID),
      "tap_id": Int(tapObjectID),
      "stream_sr": tapFormat.mSampleRate,
      "stream_ch": Int(tapFormat.mChannelsPerFrame),
    ])
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    timer.schedule(deadline: .now() + 1.0, repeating: 1.0)
    timer.setEventHandler { [weak self] in
      guard let self = self else { return }
      var r: UInt32 = 0
      var sz = UInt32(MemoryLayout<UInt32>.size)
      var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunning,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      _ = AudioObjectGetPropertyData(self.aggregateID, &addr, 0, nil, &sz, &r)
      StatusEvent.emit([
        "event": "diag",
        "ioproc_fires": NSNumber(value: self.ioProcFireCount),
        "device_is_running": Int(r),
      ])
    }
    timer.resume()
    self.diagTimer = timer

    if opts.captureMic { try startMicEngine() }
  }

  /// Run a separate AVAudioEngine for the mic; convert to mono 48k Float32
  /// and append owned frames onto the shared capture clock for 50/50 mixing
  /// with the tap stream. Two engines lets each manage its own clock.
  private func startMicEngine() throws {
    let micEngine = AVAudioEngine()
    self.micEngine = micEngine
    let micInput = micEngine.inputNode
    let micFormat = micInput.outputFormat(forBus: 0)
    guard micFormat.sampleRate > 0 else {
      // No mic available; carry on without mic.
      self.micEngine = nil
      return
    }
    let micConverter = AVAudioConverter(from: micFormat, to: writeFormat)
    let requestedFrames: AVAudioFrameCount = 4096
    timeline.expectPacket(frames: Int64(ceil(Double(requestedFrames) * writeFormat.sampleRate / micFormat.sampleRate)))
    StatusEvent.emit([
      "event": "diag", "stage": "mic_format",
      "sample_rate": micFormat.sampleRate, "channels": Int(micFormat.channelCount),
      "requested_frames": Int(requestedFrames),
    ])
    micInput.installTap(onBus: 0, bufferSize: requestedFrames, format: micFormat) { [weak self] buffer, time in
      guard let self = self, let conv = micConverter else { return }
      let outFrames = AVAudioFrameCount(Double(buffer.frameLength) * (self.writeFormat.sampleRate / micFormat.sampleRate)) + 1024
      guard let outBuf = AVAudioPCMBuffer(pcmFormat: self.writeFormat, frameCapacity: outFrames) else { return }
      var err: NSError?
      var supplied = false
      let _ = conv.convert(to: outBuf, error: &err) { _, status in
        if supplied { status.pointee = .noDataNow; return nil }
        supplied = true
        status.pointee = .haveData
        return buffer
      }
      if err != nil { return }
      self.emitLevel(source: "mic", buffer: outBuf)
      self.enqueue(outBuf, source: .mic, hostTime: time.isHostTimeValid ? time.hostTime : mach_absolute_time(), inputFrames: Int(buffer.frameLength))
    }
    try micEngine.start()
  }

  fileprivate func handleIOProc(inputData: UnsafePointer<AudioBufferList>,
                                inputTime: UnsafePointer<AudioTimeStamp>) {
    ioProcFireCount &+= 1
    guard let src = sourceFormat else { return }
    let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
    // First buffer in the ABL holds the deinterleaved channels (or the
    // interleaved data if mChannelsPerFrame > 1 with mNumberBuffers == 1).
    guard abl.count > 0 else { return }
    let firstBuf = abl[0]
    let bytesPerChannel = MemoryLayout<Float>.size
    let frames = Int(firstBuf.mDataByteSize) / max(Int(firstBuf.mNumberChannels), 1) / bytesPerChannel
    if ioProcFireCount <= 3 || ioProcFireCount % 200 == 0 {
      // Compute per-buffer peak so we can see which stream has signal.
      var peaks: [Double] = []
      for b in 0..<abl.count {
        let buf = abl[b]
        let n = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
        var pk: Float = 0
        if let data = buf.mData {
          let p = data.bindMemory(to: Float.self, capacity: n)
          for i in 0..<n { pk = max(pk, abs(p[i])) }
        }
        peaks.append(Double(pk))
      }
      StatusEvent.emit([
        "event": "diag",
        "stage": "ioproc",
        "fire": NSNumber(value: ioProcFireCount),
        "abl_count": Int(abl.count),
        "buf0_bytes": Int(firstBuf.mDataByteSize),
        "buf0_chans": Int(firstBuf.mNumberChannels),
        "frames": frames,
        "buf_peaks": peaks,
      ])
    }
    guard frames > 0 else { return }

    // Wrap ABL in an AVAudioPCMBuffer for AVAudioConverter.
    guard let inputBuf = AVAudioPCMBuffer(pcmFormat: src,
                                          bufferListNoCopy: inputData,
                                          deallocator: nil) else {
      if ioProcFireCount <= 3 {
        StatusEvent.emit(["event": "diag", "stage": "pcmbuf_nil"])
      }
      return
    }

    // Output mono buffer sized for any sample-rate ratio. Input/output use
    // the same sample rate (48k → 48k); allocate frames + slack.
    let outFrameCapacity = AVAudioFrameCount(Double(frames) * writeFormat.sampleRate / src.sampleRate) + 1024
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: writeFormat,
                                        frameCapacity: outFrameCapacity) else { return }

    var convError: NSError?
    var supplied = false
    let _ = converter?.convert(to: outBuf, error: &convError) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return inputBuf
    }
    guard convError == nil else {
      if ioProcFireCount <= 3 {
        StatusEvent.emit(["event": "diag", "stage": "conv_err",
                          "err": String(describing: convError)])
      }
      return
    }
    if ioProcFireCount <= 3 {
      StatusEvent.emit(["event": "diag", "stage": "post_conv",
                        "out_frames": Int(outBuf.frameLength)])
    }

    emitLevel(source: "system", buffer: outBuf)
    enqueue(outBuf, source: .system, hostTime: inputTime.pointee.mHostTime, inputFrames: frames)
  }

  private func emitLevel(source: String, buffer: AVAudioPCMBuffer) {
    let now = Date().timeIntervalSince1970
    levelLock.lock()
    if Self.peakDB(buffer) > -50 { lastSignalAt = .init() }
    let shouldEmit = now - (lastLevelEmitAt[source] ?? 0) > 0.1
    if shouldEmit { lastLevelEmitAt[source] = now }
    levelLock.unlock()
    guard shouldEmit else { return }
    StatusEvent.emit([
      "event": "level",
      "source": source,
      "peak_db": Self.peakDB(buffer),
    ])
  }

  private func currentFrame() -> Int64 {
    Int64(max(0, AVAudioTime.seconds(forHostTime: mach_absolute_time()) - originSeconds) * 48_000)
  }

  private func enqueue(_ buffer: AVAudioPCMBuffer, source: CaptureTimeline.Source, hostTime: UInt64, inputFrames: Int) {
    guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
    let samples = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
    let seconds = AVAudioTime.seconds(forHostTime: hostTime == 0 ? mach_absolute_time() : hostTime)
    let start = Int64((seconds - originSeconds) * 48_000)
    let arrival = currentFrame()
    timeline.append(samples, source: source, startFrame: start, arrivalFrame: arrival)
    let name = source == .mic ? "mic" : "system"
    // First packet, then at most one metadata event per source every 5s.
    let shouldEmit = timingLock.withLock { () -> Bool in
      if let last = lastTimingEmitFrame[name], arrival - last < 240_000 { return false }
      lastTimingEmitFrame[name] = arrival
      return true
    }
    if shouldEmit {
      let timing = timeline.timing
      StatusEvent.emit([
        "event": "diag", "stage": "capture_timing", "source": name,
        "input_frames": inputFrames, "converted_frames": samples.count,
        "callback_age_ms": Double(max(0, arrival - start)) / 48,
        "holdback_ms": Double(timing.holdbackFrames) / 48,
        "mic_late_frames": NSNumber(value: timing.micLateFrames),
        "system_late_frames": NSNumber(value: timing.systemLateFrames),
      ])
    }
  }

  private func startMixClock() {
    // The timeline holds back enough for actual source packet durations and
    // arrival latency. Keep AAC work off both real-time audio callbacks.
    let timer = DispatchSource.makeTimerSource(queue: mixQueue)
    timer.schedule(deadline: .now() + .milliseconds(120), repeating: .milliseconds(20))
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      let now = self.currentFrame()
      while let chunk = self.timeline.drainReady(at: now) { self.writeChunk(chunk) }
    }
    mixTimer = timer; timer.resume()
  }

  private func writeChunk(_ chunk: CaptureTimeline.Chunk) {
    func buffer(_ samples: [Float]) -> AVAudioPCMBuffer? {
      guard let b = AVAudioPCMBuffer(pcmFormat: writeFormat, frameCapacity: AVAudioFrameCount(samples.count)),
            let channel = b.floatChannelData?[0] else { return nil }
      b.frameLength = AVAudioFrameCount(samples.count)
      for (i, sample) in samples.enumerated() { channel[i] = sample }
      return b
    }
    if let voice = buffer(chunk.mic) { writerVoice?.append(voice, at: 0) }
    if let app = buffer(chunk.system) { writerSystem?.append(app, at: 0) }
    if let mixed = buffer(chunk.mixed) {
      writerMixed?.append(mixed, at: 0)
      emitLevel(source: "mixed", buffer: mixed)
    }
  }

  private func stopAggregateIO() {
    diagTimer?.cancel(); diagTimer = nil
    StatusEvent.emit([
      "event": "diag",
      "stage": "stop",
      "ioproc_fires_total": NSNumber(value: ioProcFireCount),
    ])
    if aggregateRunning, let pid = ioProcID {
      _ = AudioDeviceStop(aggregateID, pid)
      _ = AudioDeviceDestroyIOProcID(aggregateID, pid)
      aggregateRunning = false
      ioProcID = nil
    }
    micEngine?.stop()
    micEngine?.inputNode.removeTap(onBus: 0)
  }

  // MARK: - Mic engine (added in Task 9)

  private static func peakDB(_ buffer: AVAudioPCMBuffer) -> Double {
    guard let channels = buffer.floatChannelData else { return -160 }
    let n = Int(buffer.frameLength)
    var peak: Float = 0
    for c in 0..<Int(buffer.format.channelCount) {
      for i in 0..<n {
        peak = max(peak, abs(channels[c][i]))
      }
    }
    return peak == 0 ? -160 : 20 * log10(Double(peak))
  }
}
