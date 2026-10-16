import Foundation
import FluidAudio
import Darwin

@main
struct ParakeetComparison {
    static func main() async throws {
        guard CommandLine.arguments.count == 3 else {
            throw NSError(domain: "Benchmark", code: 1, userInfo: [NSLocalizedDescriptionKey: "Usage: parakeet-comparison audio-file model-cache-directory"])
        }
        let output = FileHandle(fileDescriptor: dup(STDOUT_FILENO), closeOnDealloc: true)
        dup2(STDERR_FILENO, STDOUT_FILENO)
        let cache = URL(fileURLWithPath: CommandLine.arguments[2])
        let loadStart = Date()
        let models = try await AsrModels.downloadAndLoad(to: cache, version: .v2)
        let manager = AsrManager()
        try await manager.loadModels(models)
        let start = Date()
        var state = try TdtDecoderState()
        let result = try await manager.transcribe(URL(fileURLWithPath: CommandLine.arguments[1]), decoderState: &state)
        let value: [String: Any] = ["text": result.text, "inferenceMs": Date().timeIntervalSince(start) * 1000,
            "totalMs": Date().timeIntervalSince(loadStart) * 1000, "sdk": "FluidAudio-0.17.7", "model": "parakeet-v2-int8"]
        output.write(try JSONSerialization.data(withJSONObject: value)); output.write(Data([10]))
    }
}
