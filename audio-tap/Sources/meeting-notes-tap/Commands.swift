import Foundation

// Three modes: actually record, probe permissions, list audio-producing
// processes. The renderer-facing API in Electron picks the right mode.
enum Command {
  case record(RecordOptions)
  case probePermissions
  case listAudioProcesses

  static func parse(_ args: [String]) -> Command {
    var args = args
    args.removeFirst() // executable path
    if args.contains("--probe-permissions") { return .probePermissions }
    if args.contains("--list-audio-processes") { return .listAudioProcesses }
    return .record(RecordOptions.parse(args))
  }
}

struct RecordOptions {
  var pid: pid_t?               // nil ↔ system-wide audio
  var systemAudio: Bool
  var captureMic: Bool
  var outputPath: String
  var idleStopSeconds: Int

  static func parse(_ args: [String]) -> RecordOptions {
    var pid: pid_t? = nil
    var systemAudio = false
    var captureMic = true
    var outputPath = ""
    var idleStop = 4 * 60 * 60 // 4 hour safety stop

    var i = 0
    while i < args.count {
      switch args[i] {
      case "--pid":
        i += 1
        guard i < args.count, let p = pid_t(args[i]) else { StatusEvent.error("--pid requires integer") }
        pid = p
      case "--system-audio": systemAudio = true
      case "--mic": captureMic = true
      case "--no-mic": captureMic = false
      case "--out":
        i += 1
        guard i < args.count else { StatusEvent.error("--out requires path") }
        outputPath = args[i]
      case "--idle-stop-seconds":
        i += 1
        guard i < args.count, let n = Int(args[i]) else { StatusEvent.error("--idle-stop-seconds requires integer") }
        idleStop = n
      default:
        StatusEvent.error("unknown flag: \(args[i])")
      }
      i += 1
    }
    if outputPath.isEmpty { StatusEvent.error("--out is required") }
    if pid == nil && !systemAudio { StatusEvent.error("--pid <n> or --system-audio is required") }
    return RecordOptions(
      pid: pid, systemAudio: systemAudio, captureMic: captureMic,
      outputPath: outputPath, idleStopSeconds: idleStop
    )
  }
}
