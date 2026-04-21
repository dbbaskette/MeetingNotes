import AudioToolbox
import CoreAudio
import AppKit

struct AudioProcess {
  let pid: pid_t
  let bundleID: String?
  let name: String?
}

// Recognized meeting apps surface first in the renderer's source picker.
// Bundle IDs only — display names come from the running app's metadata.
let MEETING_APP_BUNDLE_IDS: Set<String> = [
  "us.zoom.xos",
  "com.microsoft.teams2",
  "com.microsoft.teams",
  "com.apple.FaceTime",
  "com.tinyspeck.slackmacgap",
  "com.hnc.Discord",
  "WhatsApp",
  "net.whatsapp.WhatsApp",
]

enum ProcessList {
  /// Returns every process CoreAudio currently knows about as producing audio.
  static func enumerate() -> [AudioProcess] {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyProcessObjectList,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size
    )
    guard status == noErr, size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    status = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids
    )
    guard status == noErr else { return [] }
    return ids.compactMap(read)
  }

  private static func read(_ id: AudioObjectID) -> AudioProcess? {
    var pidAddress = AudioObjectPropertyAddress(
      mSelector: kAudioProcessPropertyPID,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var pid: pid_t = 0
    var pidSize = UInt32(MemoryLayout<pid_t>.size)
    let status = AudioObjectGetPropertyData(id, &pidAddress, 0, nil, &pidSize, &pid)
    guard status == noErr, pid > 0 else { return nil }

    let app = NSRunningApplication(processIdentifier: pid)
    return AudioProcess(
      pid: pid,
      bundleID: app?.bundleIdentifier,
      name: app?.localizedName
    )
  }
}
