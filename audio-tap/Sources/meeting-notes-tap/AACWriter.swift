import AVFoundation
import CoreMedia

// Wraps AVAssetWriter for streaming-write of mono AAC into M4A.
// Caller passes mono Float32 PCM buffers via append(_:); on stop(),
// finalizes the container so the file is playable.
final class AACWriter {
  private let writer: AVAssetWriter
  private let input: AVAssetWriterInput
  private let sourceFormat: AVAudioFormat
  private var started = false
  private var firstSampleTime: CMTime = .zero

  init(outputURL: URL, sampleRate: Double, bitrate: Int) throws {
    // Delete any existing file — caller picks unique paths so this is paranoia.
    try? FileManager.default.removeItem(at: outputURL)
    writer = try AVAssetWriter(outputURL: outputURL, fileType: .m4a)
    sourceFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: sampleRate,
      channels: 1,
      interleaved: false
    )!
    let outputSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVNumberOfChannelsKey: 1,
      AVSampleRateKey: sampleRate,
      AVEncoderBitRateKey: bitrate,
    ]
    input = AVAssetWriterInput(mediaType: .audio, outputSettings: outputSettings)
    input.expectsMediaDataInRealTime = true
    writer.add(input)
  }

  func append(_ buffer: AVAudioPCMBuffer, at hostTime: UInt64) {
    let pts = CMTime(value: CMTimeValue(hostTime), timescale: 1_000_000_000)
    if !started {
      firstSampleTime = pts
      writer.startWriting()
      writer.startSession(atSourceTime: .zero)
      started = true
    }
    let relativeTime = CMTimeSubtract(pts, firstSampleTime)
    guard let sampleBuffer = buffer.toCMSampleBuffer(presentationTime: relativeTime) else { return }
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.001) }
    input.append(sampleBuffer)
  }

  func finalize() async {
    input.markAsFinished()
    await writer.finishWriting()
  }

  var bytesWritten: Int64 {
    // Best-effort byte count for the stopped event — ask the file system.
    (try? FileManager.default.attributesOfItem(atPath: writer.outputURL.path)[.size] as? NSNumber)?.int64Value ?? 0
  }
}

private extension AVAudioPCMBuffer {
  // Pack a PCM buffer into a CMSampleBuffer at a given timestamp. AVAssetWriter
  // wants CMSampleBuffer, AVAudioEngine gives us AVAudioPCMBuffer — bridge.
  func toCMSampleBuffer(presentationTime: CMTime) -> CMSampleBuffer? {
    let asbd = format.streamDescription.pointee
    var formatDescription: CMAudioFormatDescription?
    var err = CMAudioFormatDescriptionCreate(
      allocator: kCFAllocatorDefault,
      asbd: format.streamDescription,
      layoutSize: 0, layout: nil,
      magicCookieSize: 0, magicCookie: nil,
      extensions: nil,
      formatDescriptionOut: &formatDescription
    )
    guard err == noErr, let fd = formatDescription else { return nil }

    var timing = CMSampleTimingInfo(
      duration: CMTime(value: CMTimeValue(frameLength), timescale: CMTimeScale(asbd.mSampleRate)),
      presentationTimeStamp: presentationTime,
      decodeTimeStamp: .invalid
    )
    var sampleBuffer: CMSampleBuffer?
    err = CMSampleBufferCreate(
      allocator: kCFAllocatorDefault,
      dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
      formatDescription: fd,
      sampleCount: CMItemCount(frameLength),
      sampleTimingEntryCount: 1, sampleTimingArray: &timing,
      sampleSizeEntryCount: 0, sampleSizeArray: nil,
      sampleBufferOut: &sampleBuffer
    )
    guard err == noErr, let sb = sampleBuffer else { return nil }
    err = CMSampleBufferSetDataBufferFromAudioBufferList(
      sb, blockBufferAllocator: kCFAllocatorDefault,
      blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0,
      bufferList: audioBufferList
    )
    guard err == noErr else { return nil }
    return sb
  }
}
