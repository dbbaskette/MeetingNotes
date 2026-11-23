import Foundation
import WhisperKit
import ArgmaxCore

struct WhisperKitTranscriptionResult: Encodable {
    let text: String
    let segments: [TimedText]
    let durationS: Double
    let provider: String
    let model: String
    let locale: String
    let osVersion: String
}

/// Optional high-accuracy engine (#306): Whisper large-v3-turbo as Core ML,
/// run in this helper. The app downloads and hash-verifies the model files
/// during explicit setup; nothing here may download.
enum WhisperKitTranscription {
    /// Argmax's compressed large-v3-turbo build.
    static let model = "openai_whisper-large-v3-v20240930_626MB"
    static let requiredFiles = ["AudioEncoder.mlmodelc", "MelSpectrogram.mlmodelc", "TextDecoder.mlmodelc", "config.json", "tokenizer.json"]
    /// Chunks decoded at once. Each is at most one 30-second window.
    static let workers = 4
    /// Whisper conditions on at most 223 prompt tokens and keeps the last
    /// ones; stay under that so the first terms are not the ones dropped.
    static let maxPromptTokens = 200

    /// "en-US" → "en". Whisper takes a bare language code.
    static func languageCode(_ requested: String?) throws -> String {
        let value = (requested ?? "en").trimmingCharacters(in: .whitespacesAndNewlines)
        let code = value.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map { $0.lowercased() } ?? ""
        guard Constants.languages.values.contains(code) else {
            throw SpeechFailure("WhisperKit does not support the language “\(value)”. Choose a supported language in Settings → Processing.")
        }
        return code
    }

    /// Whisper reads a prompt as the text that came before, so a short
    /// glossary sentence nudges it toward these spellings.
    static func promptTokens(_ strings: [String]?, encode: (String) -> [Int], specialTokenBegin: Int) -> [Int]? {
        let terms = vocabulary(strings)
        guard !terms.isEmpty else { return nil }
        var tokens = encode(" Glossary:").filter { $0 < specialTokenBegin }
        var added = 0
        for term in terms {
            let next = encode((added == 0 ? " " : ", ") + term).filter { $0 < specialTokenBegin }
            if tokens.count + next.count > maxPromptTokens { break }
            tokens.append(contentsOf: next)
            added += 1
        }
        return added == 0 ? nil : tokens
    }

    /// Flatten to one entry per word with its own audio time. Word offsets are
    /// never estimated: a segment with text but no word timing is an error.
    static func timedWords(_ segments: [TranscriptionSegment], duration: Double) throws -> [TimedText] {
        var words: [(order: Int, word: TimedText)] = []
        for segment in segments {
            let timings = segment.words ?? []
            if timings.isEmpty {
                guard segment.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw SpeechFailure("WhisperKit returned text without word timestamps. Previous results were retained.")
                }
                continue
            }
            for timing in timings {
                let text = timing.word.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                guard timing.start.isFinite, timing.end.isFinite else {
                    throw SpeechFailure("WhisperKit returned invalid timestamps; the previous result was retained.")
                }
                // Float rounding can put the last word a few milliseconds past the end of the file.
                let start = min(max(0, Double(timing.start)), duration)
                let end = min(max(start, Double(timing.end)), duration)
                words.append((words.count, TimedText(start: start, end: end, text: text)))
            }
        }
        // Chunks are decoded concurrently; order by time, keeping decode order for ties.
        return words.sorted { $0.word.start != $1.word.start ? $0.word.start < $1.word.start : $0.order < $1.order }.map(\.word)
    }

    static func modelFolder(_ request: Request) throws -> URL {
        guard let folder = request.modelFolder, folder.hasPrefix("/") else {
            throw SpeechFailure("Choose an app-owned WhisperKit model folder.")
        }
        let url = URL(fileURLWithPath: folder, isDirectory: true)
        for name in requiredFiles where !FileManager.default.fileExists(atPath: url.appendingPathComponent(name).path) {
            throw SpeechFailure("The WhisperKit model is not installed. Download it in Settings → Processing; no download was started automatically.")
        }
        return url
    }

    static func load(_ folder: URL) async throws -> WhisperKit {
        // The SDK's tokenizer loader falls back to a Hub download when the
        // local files do not load. Prove they load first, so that path is never taken.
        do { _ = try await AutoTokenizerWrapper.from(modelFolder: folder) }
        catch { throw SpeechFailure("The WhisperKit tokenizer files are damaged. Download the model again in Settings → Processing.") }
        let config = WhisperKitConfig(model: model, modelFolder: folder.path, tokenizerFolder: folder,
                                      verbose: false, logLevel: .error, prewarm: false, load: true, download: false)
        return try await WhisperKit(config)
    }

    /// Loads the models once so Core ML specializes them for this Mac during
    /// setup, not during the first meeting, and proves the files are usable.
    static func prepare(_ request: Request) async throws -> [String: Any] {
        let kit = try await load(try modelFolder(request))
        guard kit.tokenizer != nil else { throw SpeechFailure("The WhisperKit tokenizer did not load.") }
        return ["installed": true, "model": model]
    }

    static func transcribe(_ request: Request, progress: @escaping (Double) -> Void = { _ in }) async throws -> WhisperKitTranscriptionResult {
        let url = try requiredAudio(request)
        let folder = try modelFolder(request)
        let language = try languageCode(request.locale)
        async let kitTask = load(folder)
        let audioTask = Task.detached(priority: .userInitiated) { try SpeakerProcessing.loadAudio(url) }
        let (kit, audio) = try await (kitTask, audioTask.value)
        guard let tokenizer = kit.tokenizer else { throw SpeechFailure("The WhisperKit tokenizer did not load.") }
        let duration = Double(audio.count) / Double(WhisperKit.sampleRate)
        var options = DecodingOptions(
            verbose: false, task: .transcribe, language: language, temperature: 0,
            usePrefillPrompt: true, detectLanguage: false, skipSpecialTokens: true,
            withoutTimestamps: false, wordTimestamps: true,
            promptTokens: promptTokens(request.contextualStrings, encode: tokenizer.encode(text:),
                                       specialTokenBegin: tokenizer.specialTokens.specialTokenBegin),
            concurrentWorkerCount: workers)
        // Split on silence ourselves and decode in small batches. The SDK's own
        // chunked path drops a failed chunk with only a log line, which would
        // leave a silent hole in the transcript.
        let window = kit.featureExtractor.windowSamples ?? Constants.defaultWindowSamples
        let chunks = try await VADAudioChunker().chunkAll(audioArray: audio, maxChunkLength: window, decodeOptions: options)
        options.chunkingStrategy = ChunkingStrategy.none
        var segments: [TranscriptionSegment] = []
        var texts: [String] = []
        var index = 0
        while index < chunks.count {
            try Task.checkCancellation()
            let batch = Array(chunks[index..<min(index + workers, chunks.count)])
            let results = await kit.transcribeWithOptions(
                audioArrays: batch.map(\.audioSamples),
                decodeOptionsArray: Array(repeating: options, count: batch.count))
            guard results.count == batch.count else { throw SpeechFailure("WhisperKit returned an incomplete result. Previous results were retained.") }
            for (chunk, result) in zip(batch, results) {
                let seekTime = Float(chunk.seekOffsetIndex) / Float(WhisperKit.sampleRate)
                for transcription in try result.get() {
                    segments.append(contentsOf: transcription.segments.map {
                        TranscriptionUtilities.updateSegmentTimings(segment: $0, seekTime: seekTime)
                    })
                    let text = transcription.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty { texts.append(text) }
                }
            }
            index += batch.count
            progress(min(0.99, Double(index) / Double(chunks.count)))
        }
        let words = try timedWords(segments, duration: duration)
        try validateSegments(words, duration: duration)
        return WhisperKitTranscriptionResult(
            text: texts.joined(separator: " "), segments: words, durationS: duration,
            provider: "whisperkit", model: model, locale: language,
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString)
    }
}
