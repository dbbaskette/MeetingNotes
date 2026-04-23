import AudioToolbox
import CoreAudio
import AppKit

struct AudioProcess {
  let pid: pid_t
  let bundleID: String?
  let name: String?
  /// True iff CoreAudio reports this process is currently writing audio to
  /// an output device. Attaching a Process Tap to a process whose output is
  /// idle (e.g. Zoom launched but not yet in a meeting) can disrupt the
  /// process's device negotiation when it later tries to start audio — see
  /// issue #33. The picker uses this flag to dim / warn about idle targets.
  let isRunningOutput: Bool
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

    // kAudioProcessPropertyIsRunningOutput is a UInt32 boolean. Best-effort:
    // older macOS 14.2 builds may not have the property; treat "read failed"
    // as "unknown — assume running" so we don't accidentally hide usable
    // targets on older systems.
    var runningOutput: UInt32 = 1
    var runAddr = AudioObjectPropertyAddress(
      mSelector: kAudioProcessPropertyIsRunningOutput,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var runSize = UInt32(MemoryLayout<UInt32>.size)
    _ = AudioObjectGetPropertyData(id, &runAddr, 0, nil, &runSize, &runningOutput)

    let app = NSRunningApplication(processIdentifier: pid)
    return AudioProcess(
      pid: pid,
      bundleID: app?.bundleIdentifier,
      name: app?.localizedName,
      isRunningOutput: runningOutput != 0
    )
  }
}
