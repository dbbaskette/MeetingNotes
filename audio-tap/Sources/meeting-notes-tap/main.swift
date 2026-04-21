import Foundation

let cmd = Command.parse(CommandLine.arguments)

switch cmd {
case .record(let opts):
  StatusEvent.emit(["event": "started", "stub": true, "out": opts.outputPath])
case .probePermissions:
  StatusEvent.emit(["event": "permissions", "mic": "unknown", "audio_capture": "unknown"])
case .listAudioProcesses:
  StatusEvent.emit(["event": "processes", "items": []])
}
