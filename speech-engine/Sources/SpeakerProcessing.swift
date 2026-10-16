import Foundation
import SpeakerKit
import ArgmaxCore
import WhisperKit

enum SpeakerProcessing {
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
        let audio = try AudioProcessor.loadAudioAsFloatArray(fromPath: audioURL.path)
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
