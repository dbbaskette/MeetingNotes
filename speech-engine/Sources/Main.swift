import Foundation
import Darwin

@main
enum SpeechMain {
    static func main() async {
        // Third-party libraries may log to stdout. Keep protocol output on an independent FD.
        let output = FileHandle(fileDescriptor: dup(STDOUT_FILENO), closeOnDealloc: true)
        dup2(STDERR_FILENO, STDOUT_FILENO)
        let parent = getppid()
        let watchdog = DispatchSource.makeTimerSource(queue: .global())
        watchdog.schedule(deadline: .now() + 1, repeating: 1)
        watchdog.setEventHandler { if getppid() != parent || parent == 1 { exit(2) } }
        watchdog.resume()
        func emit(_ value: [String: Any]) {
            guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
            output.write(bytes); output.write(Data([10]))
        }
        var id = "invalid"
        do {
            guard let line = readLine(), line.utf8.count <= 65_536 else { throw SpeechFailure("Invalid speech request.") }
            let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
            id = request.id
            guard request.version == 1, !id.isEmpty, id.count < 201 else { throw SpeechFailure("Unsupported speech protocol.") }
            let begin = Date()
            let result: [String: Any]
            switch request.operation {
            case "health":
                if #available(macOS 26, *) { result = try await AppleTranscription.health(locale: request.locale ?? "en-US") }
                else { result = ["available": false, "installed": false, "status": "Requires macOS 26 or later"] }
            case "provision-apple":
                guard #available(macOS 26, *) else { throw SpeechFailure("Apple transcription requires macOS 26 or later.") }
                try await AppleTranscription.provision(locale: request.locale ?? "en-US") { fraction in
                    emit(["version": 1, "id": id, "kind": "progress", "fraction": fraction])
                }
                result = ["installed": true]
            case "transcribe":
                guard #available(macOS 26, *) else { throw SpeechFailure("Apple transcription requires macOS 26 or later.") }
                result = try await AppleTranscription.transcribe(request)
            case "provision-speakers": result = try await SpeakerProcessing.provision(request)
            case "diarize": result = try await SpeakerProcessing.diarize(request)
            default: throw SpeechFailure("Unknown speech operation.")
            }
            emit(["version": 1, "id": id, "kind": "result", "elapsedMs": Date().timeIntervalSince(begin) * 1000, "result": result])
        } catch {
            emit(["version": 1, "id": id, "kind": "error", "message": error.localizedDescription])
            exit(1)
        }
        watchdog.cancel()
    }
}
