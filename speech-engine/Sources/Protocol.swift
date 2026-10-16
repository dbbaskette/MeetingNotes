import Foundation

struct Request: Decodable {
    let version: Int
    let id: String
    let operation: String
    let audioPath: String?
    let locale: String?
    let modelFolder: String?
    let modelRevision: String?
}

struct SpeechFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct TimedText: Codable {
    let start: Double
    let end: Double
    let text: String
}

func validateSegments(_ segments: [TimedText], duration: Double) throws {
    var previous = -Double.infinity
    for segment in segments {
        guard segment.start.isFinite, segment.end.isFinite,
              segment.start >= 0, segment.end >= segment.start,
              segment.end <= duration + 0.5, segment.start >= previous else {
            throw SpeechFailure("The speech engine returned invalid timestamps; the previous result was retained.")
        }
        previous = segment.start
    }
}

func usableVector(_ vector: [Float]) -> Bool {
    !vector.isEmpty && vector.allSatisfy(\.isFinite) && vector.reduce(0.0) { $0 + Double($1) * Double($1) } > 1e-12
}

func requiredAudio(_ request: Request) throws -> URL {
    guard let path = request.audioPath, path.hasPrefix("/"),
          FileManager.default.isReadableFile(atPath: path) else {
        throw SpeechFailure("Choose a readable local audio file.")
    }
    let url = URL(fileURLWithPath: path)
    guard try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
        throw SpeechFailure("The audio path must refer to a regular file.")
    }
    return url
}
