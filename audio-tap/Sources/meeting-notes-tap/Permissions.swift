import AVFoundation
import AudioToolbox
import CoreAudio

enum PermissionState: String {
  case granted, denied, notDetermined = "not-determined", unknown
}

enum Permissions {
  static func microphone() -> PermissionState {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return .granted
    case .denied, .restricted: return .denied
    case .notDetermined: return .notDetermined
    @unknown default: return .unknown
    }
  }

  /// No public API to query Process Tap permission state. We probe by
  /// attempting to create a tap with no targets and reading the OS error.
  /// `kAudioHardwareUnpermittedErr` ↔ denied; `noErr` ↔ granted; anything
  /// else ↔ not-determined / unknown.
  static func audioCapture() -> PermissionState {
    let description = CATapDescription(stereoMixdownOfProcesses: [])
    var tapID: AUAudioObjectID = 0
    let status = AudioHardwareCreateProcessTap(description, &tapID)
    defer {
      if tapID != 0 { _ = AudioHardwareDestroyProcessTap(tapID) }
    }
    // No symbolic constant exposed for the TCC-denied case in Swift
    // headers; the four-char-code `'!aut'` (= 560557684) is what CoreAudio
    // returns when Process Tap permission is denied.
    let unpermittedErr: OSStatus = 0x21617574  // '!aut'
    switch status {
    case noErr: return .granted
    case unpermittedErr: return .denied
    default: return .notDetermined
    }
  }
}
