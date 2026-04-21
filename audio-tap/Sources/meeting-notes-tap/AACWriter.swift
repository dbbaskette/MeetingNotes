import AVFoundation
import CoreMedia

// Streaming-write of mono PCM into an M4A/AAC file via AVAudioFile.
// AVAudioFile handles the AAC encode + M4A container internally and avoids
// the CMSampleBuffer construction landmines of AVAssetWriter for our case
// (where the source ABL layout from the tap doesn't always satisfy
// CMSampleBufferSetDataBufferFromAudioBufferList's strict requirements).
final class AACWriter {
  private let outputURL: URL
  private let processingFormat: AVAudioFormat
  private var file: AVAudioFile?
  private var started = false
  private let queue = DispatchQueue(label: "AACWriter.serialize")

  init(outputURL: URL, sampleRate: Double, bitrate: Int) throws {
    self.outputURL = outputURL
    try? FileManager.default.removeItem(at: outputURL)
    // Mono Float32 — matches what Recorder feeds us.
    self.processingFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: sampleRate,
      channels: 1,
      interleaved: false
    )!
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVNumberOfChannelsKey: 1,
      AVSampleRateKey: sampleRate,
      AVEncoderBitRateKey: bitrate,
    ]
    do {
      // commonFormat passed here tells AVAudioFile what format the buffers
      // we'll write are in (Float32 PCM); the on-disk format is AAC per
      // settings.
      self.file = try AVAudioFile(
        forWriting: outputURL,
        settings: settings,
        commonFormat: .pcmFormatFloat32,
        interleaved: false
      )
      self.started = true
    } catch {
      StatusEvent.emit(["event": "diag", "stage": "avaudiofile_create_err",
                        "err": String(describing: error)])
      throw error
    }
  }

  func append(_ buffer: AVAudioPCMBuffer, at hostTime: UInt64) {
    queue.sync {
      guard let file = file else { return }
      do {
        try file.write(from: buffer)
      } catch {
        StatusEvent.emit(["event": "diag", "stage": "avaudiofile_write_err",
                          "err": String(describing: error)])
      }
    }
  }

  func finalize() async {
    queue.sync {
      // Releasing the file flushes the AAC encoder and finalizes the M4A.
      file = nil
    }
  }

  var bytesWritten: Int64 {
    (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? NSNumber)?.int64Value ?? 0
  }
}
