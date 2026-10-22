import Foundation
import AVFoundation
import SpeakerKit
import ArgmaxCore
import WhisperKit

enum SpeakerProcessing {
    /// Same resampler and ten-minute boundaries as the pinned SDK loader, but
    /// reserve the final array once and append PCM directly, avoiding intermediate
    /// float arrays and repeated growth copies. Identity/clustering stays global.
    static func loadAudio(_ url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        let duration = Double(file.length) / file.fileFormat.sampleRate
        let expected = ceil(duration * Double(WhisperKit.sampleRate))
        guard duration.isFinite, duration >= 0, expected < Double(Int.max) else {
            throw SpeechFailure("Audio duration is invalid or too large to decode safely.")
        }
        var audio: [Float] = []
        audio.reserveCapacity(Int(expected))
        var start = 0.0
        while start < duration {
            let end = min(start + 600, duration)
            try autoreleasepool {
                let buffer = try AudioProcessor.loadAudio(fromFile: file, startTime: start, endTime: end)
                guard buffer.format.channelCount == 1, let channels = buffer.floatChannelData else {
                    throw SpeechFailure("Audio could not be decoded into mono speech samples.")
                }
                audio.append(contentsOf: UnsafeBufferPointer(start: channels[0], count: Int(buffer.frameLength)))
            }
            start = end
        }
        return audio
    }
    static func configuration(_ request: Request, download: Bool) throws -> PyannoteConfig {
        guard let folder = request.modelFolder, folder.hasPrefix("/"),
              let revision = request.modelRevision, revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil else {
            throw SpeechFailure("Choose an app-owned model folder and a pinned SpeakerKit model revision.")
        }
        return PyannoteConfig(downloadBase: folder, modelRepo: "argmaxinc/speakerkit-coreml", modelToken: nil,
                              modelFolder: download ? nil : folder, download: download,
                              downloadRevision: revision, load: !download, verbose: false, logLevel: .error)
    }

    static func provision(_ request: Request) async throws -> [String: Any] {
        let config = try configuration(request, download: true)
        let kit = try await SpeakerKit(config)
        // Return the actual resolved model folder, rather than assuming the Hub's cache layout.
        guard let folder = (kit.diarizer as? PyannoteDiarizer)?.modelFolder else {
            throw SpeechFailure("SpeakerKit did not resolve a model directory.")
        }
        return ["installed": true, "modelFolder": folder.path]
    }

    static func diarize(_ request: Request) async throws -> [String: Any] {
        let audioURL = try requiredAudio(request)
        let kit = try await SpeakerKit(configuration(request, download: false))
        let audio = try loadAudio(audioURL)
        let result = try await kit.diarize(audioArray: audio, options: PyannoteDiarizationOptions(centroidSource: .trainableOnly))
        let centroids = Dictionary(uniqueKeysWithValues: result.speakerCentroidEmbeddings.compactMap { id, vector -> (String, [Float])? in
            usableVector(vector) ? (String(format: "SPEAKER_%02d", id), vector) : nil
        })
        let segments: [[String: Any]] = result.segments.compactMap { segment in
            guard let id = segment.speaker.speakerId else { return nil }
            return ["start": Double(segment.startFrame) / Double(result.frameRate),
                    "end": Double(segment.endFrame) / Double(result.frameRate),
                    "speaker": String(format: "SPEAKER_%02d", id)]
        }
        return ["segments": segments, "num_speakers": result.speakerCount, "centroids": centroids,
                "embeddingSpace": "speakerkit:1.1.1:\(request.modelRevision!):raw-preplda:trainableOnly:16khz",
                "provider": "speakerkit", "modelRevision": request.modelRevision!]
    }
}
