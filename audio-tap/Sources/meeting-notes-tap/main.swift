import Foundation

let cmd = Command.parse(CommandLine.arguments)

switch cmd {
case .record(let opts):
  let recorder = Recorder(opts: opts)
  do {
    try recorder.start()
  } catch {
    StatusEvent.error("start failed: \(error.localizedDescription)")
  }
  // Wait for SIGTERM. Block forever; signal handler exits.
  let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
  sigterm.setEventHandler {
    Task {
      await recorder.stop()
      exit(0)
    }
  }
  sigterm.resume()
  signal(SIGTERM, SIG_IGN)  // let DispatchSource handle it

  let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
  sigint.setEventHandler {
    Task {
      await recorder.stop()
      exit(0)
    }
  }
  sigint.resume()
  signal(SIGINT, SIG_IGN)

  // Parent died → stop and exit cleanly (orphan recovery).
  ParentWatch.onParentExit {
    Task {
      StatusEvent.emit(["event": "parent_exited"])
      await recorder.stop()
      exit(0)
    }
  }

  // Idle-stop safety net: if no audio for N seconds, stop. Prevents a
  // hard-killed parent (kernel panic) from leaving us recording silence
  // forever. Recorder updates lastSignalAt every time it writes a buffer.
  let idleTimer = DispatchSource.makeTimerSource(queue: .global())
  idleTimer.schedule(deadline: .now() + 60, repeating: 60)
  idleTimer.setEventHandler {
    if Date().timeIntervalSince(recorder.lastSignalSeen()) > Double(opts.idleStopSeconds) {
      Task {
        StatusEvent.emit(["event": "idle_stop"])
        await recorder.stop()
        exit(0)
      }
    }
  }
  idleTimer.resume()

  dispatchMain()

case .probePermissions:
  StatusEvent.emit([
    "event": "permissions",
    "mic": Permissions.microphone().rawValue,
    "audio_capture": Permissions.audioCapture().rawValue,
  ])
case .listAudioProcesses:
  let procs = ProcessList.enumerate().map { p -> [String: Any] in
    var out: [String: Any] = ["pid": Int(p.pid)]
    if let b = p.bundleID { out["bundle_id"] = b }
    if let n = p.name { out["name"] = n }
    out["is_meeting_app"] = (p.bundleID.map { MEETING_APP_BUNDLE_IDS.contains($0) }) ?? false
    out["is_running_output"] = p.isRunningOutput
    return out
  }
  StatusEvent.emit(["event": "processes", "items": procs])
}
