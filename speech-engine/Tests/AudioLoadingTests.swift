import XCTest
import AVFoundation
import WhisperKit
@testable import MeetingNotesSpeech

final class AudioLoadingTests: XCTestCase {
    func testMatchesSDKResamplingAndChannelMixing() throws {
        for (rate, channels, seconds) in [(16000.0, 1, 605.0), (44100.0, 2, 2.5), (48000.0, 1, 2.5)] {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
            defer { try? FileManager.default.removeItem(at: url) }
            let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: AVAudioChannelCount(channels))!
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(rate * seconds))!
            buffer.frameLength = buffer.frameCapacity
            for channel in 0..<channels {
                for frame in 0..<Int(buffer.frameLength) {
                    buffer.floatChannelData![channel][frame] = Float(sin(Double(frame) * 2 * .pi * Double(200 + channel * 100) / rate) * 0.1)
                }
            }
            do { let file = try AVAudioFile(forWriting: url, settings: format.settings); try file.write(from: buffer) }
            let baseline = try AudioProcessor.loadAudioAsFloatArray(fromPath: url.path)
            let optimized = try SpeakerProcessing.loadAudio(url)
            XCTAssertEqual(optimized.count, baseline.count)
            XCTAssertTrue(zip(optimized, baseline).allSatisfy { $0 == $1 }, "PCM must be bit-identical to the pinned SDK loader")
        }
    }
}
