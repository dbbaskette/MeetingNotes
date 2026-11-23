import Foundation

// One-line JSON events on stdout. Each line is a self-contained object so
// the Electron parent can read with a line-buffered stream. Serialized off
// real-time audio queues so stdout pipe backpressure never stalls IOProcs.
enum StatusEvent {
  private static let queue = DispatchQueue(label: "meetingnotes.tap.stdout", qos: .utility)

  static func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    queue.async {
      print(line)
      // Force flush — stdout is buffered when piped.
      fflush(stdout)
    }
  }

  /// Blocks until every event emitted so far has been written. Emission is
  /// asynchronous, so call this before `exit` — otherwise the parent can miss
  /// the final events (`stopped`, `target_exited`, …) it is waiting for.
  static func flush() {
    queue.sync { _ = fflush(stdout) }
  }

  /// Drain pending events, then exit.
  static func exitAfterFlush(_ code: Int32 = 0) -> Never {
    flush()
    exit(code)
  }

  static func error(_ message: String, exitCode: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("ERR \(message)\n".utf8))
    exitAfterFlush(exitCode)
  }
}
