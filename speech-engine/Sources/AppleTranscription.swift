import Foundation
import AVFoundation
import Speech

@available(macOS 26, *)
enum AppleTranscription {
    static func transcriber(_ requested: String) async throws -> SpeechTranscriber {
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: requested)) else {
            throw SpeechFailure("Apple transcription is unavailable for this Mac or language. Use Apple silicon with macOS 26 or newer and choose a supported language.")
        }
        return SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    }

    static func health(locale: String) async throws -> [String: Any] {
        let module = try await transcriber(locale)
        let state = await AssetInventory.status(forModules: [module])
        return ["available": true, "installed": state == .installed,
                "locale": module.selectedLocales.first?.identifier ?? locale,
                "status": String(describing: state)]
    }

    static func provision(locale: String, progress: @escaping (Double) -> Void) async throws {
        let module = try await transcriber(locale)
        _ = try await AssetInventory.reserve(locale: module.selectedLocales.first ?? Locale(identifier: locale))
        if let installation = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            let reporter = Task {
                while !Task.isCancelled {
                    progress(installation.progress.fractionCompleted)
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }
            }
            defer { reporter.cancel() }
            try await installation.downloadAndInstall()
        }
        guard await AssetInventory.status(forModules: [module]) == .installed else {
            throw SpeechFailure("Apple speech assets are not ready. Retry the download while online.")
        }
        progress(1)
    }

    static func transcribe(_ request: Request) async throws -> [String: Any] {
        let url = try requiredAudio(request)
        let module = try await transcriber(request.locale ?? "en-US")
        guard await AssetInventory.status(forModules: [module]) == .installed else {
            throw SpeechFailure("Prepare Apple speech assets in Settings → Processing before transcribing. No download was started automatically.")
        }
        let audio = try AVAudioFile(forReading: url)
        let duration = Double(audio.length) / audio.processingFormat.sampleRate
        let analyzer = SpeechAnalyzer(modules: [module])
        let reader = Task { () throws -> [TimedText] in
            var segments: [TimedText] = []
            for try await result in module.results {
                guard result.isFinal else { continue }
                let text = String(result.text.characters)
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                var words: [TimedText] = []
                for run in result.text.runs {
                    let portion = String(result.text[run.range].characters)
                    if let range = run.audioTimeRange {
                        words.append(TimedText(start: range.start.seconds, end: range.end.seconds, text: portion))
                    } else if !portion.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters)).isEmpty {
                        throw SpeechFailure("Apple returned words without audio timestamps. Previous results were retained.")
                    } else if let last = words.popLast() {
                        words.append(TimedText(start: last.start, end: last.end, text: last.text + portion))
                    }
                }
                // Use true word timing for speaker attribution; never estimate word offsets.
                if words.isEmpty { throw SpeechFailure("Apple returned no usable word timestamps.") }
                segments.append(contentsOf: words)
            }
            return segments
        }
        do {
            let end = try await analyzer.analyzeSequence(from: audio)
            if let end { try await analyzer.finalizeAndFinish(through: end) }
            else { try await analyzer.finalizeAndFinishThroughEndOfInput() }
            let segments = try await reader.value
            try validateSegments(segments, duration: duration)
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(segments))
            return ["text": segments.map(\.text).joined(separator: " "), "segments": encoded,
                    "durationS": duration, "provider": "apple", "locale": module.selectedLocales.first?.identifier ?? "",
                    "osVersion": ProcessInfo.processInfo.operatingSystemVersionString]
        } catch {
            await analyzer.cancelAndFinishNow()
            reader.cancel()
            throw error
        }
    }
}
