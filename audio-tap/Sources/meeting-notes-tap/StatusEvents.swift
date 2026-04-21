import Foundation

// One-line JSON events on stdout. Each line is a self-contained object so
// the Electron parent can read with a line-buffered stream.
enum StatusEvent {
  static func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    // Force flush — stdout is buffered when piped.
    fflush(stdout)
  }

  static func error(_ message: String, exitCode: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("ERR \(message)\n".utf8))
    exit(exitCode)
  }
}
