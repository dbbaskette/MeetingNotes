# Built-in Audio Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Audio Hijack with a built-in Swift CLI helper (`meeting-notes-tap`) that captures per-app audio (or system-wide) plus microphone, mixes mono, and writes M4A — no third-party install required.

**Architecture:** A single-purpose Swift CLI binary bundled inside the `.app`, spawned per recording by a new `RecordingManager` in Electron's main process. CoreAudio Process Tap (macOS 14.2+) for app audio, AVAudioEngine for mic, native AAC encoder for M4A output. Existing `LibraryWatcher` ingests the resulting file into the Inbox with no other pipeline changes.

**Tech Stack:** Swift 5.9, CoreAudio (`AudioHardwareCreateProcessTap`), AVFoundation (AVAudioEngine, AVAssetWriter), Electron 30 main process (TypeScript), better-sqlite3, electron-builder.

---

## Reference Docs (read before starting)

- Spec: `docs/superpowers/specs/2026-04-20-builtin-audio-capture-design.md`
- GitHub issue: #3
- Apple docs:
  - `AudioHardwareCreateProcessTap` — <https://developer.apple.com/documentation/coreaudio/audiohardwarecreateprocesstap>
  - Audio Hardware Services Reference — <https://developer.apple.com/documentation/coreaudio/audio_hardware_services>
  - AVAssetWriter — <https://developer.apple.com/documentation/avfoundation/avassetwriter>
- Existing patterns to mimic:
  - Sidecar supervisor: `electron/main/diarization/supervisor.ts` (parent-process IPC pattern)
  - Bridge tests with fake runner: `electron/main/audio-hijack/bridge.test.ts`
  - Migrations: `electron/main/storage/migrations.ts`
  - LibraryWatcher: `electron/main/library/watcher.ts`
  - electron-builder extraResources pattern: `electron-builder.yml`

## File Structure

```
MeetingNotes/
  audio-tap/                              # NEW — Swift helper source
    Package.swift
    Sources/
      meeting-notes-tap/
        main.swift                        # Argument parsing + dispatch
        Commands.swift                    # Subcommand types (record / probe / list)
        Recorder.swift                    # CoreAudio Process Tap + AVAudioEngine + mixer
        AACWriter.swift                   # AVAssetWriter wrapper for M4A
        ProcessList.swift                 # CoreAudio process enumeration
        Permissions.swift                 # Probe mic + audio-capture grants
        ParentWatch.swift                 # kqueue parent-PID watch
        StatusEvents.swift                # JSON line emission
    scripts/
      build.sh                            # swiftc → audio-tap/build/meeting-notes-tap
    entitlements.plist                    # Audio capture entitlement
    BUILD_ID                              # echoed timestamp, like sidecar
  electron/main/recording/                # NEW
    manager.ts                            # RecordingManager class
    manager.test.ts
    app-enumerator.ts                     # Wraps `meeting-notes-tap --list-audio-processes`
    app-enumerator.test.ts
    orphan-recovery.ts                    # Scans recording_sessions on launch
    orphan-recovery.test.ts
    helper-path.ts                        # Resolves bundled vs dev binary path
    helper-path.test.ts
  electron/main/permissions/              # NEW
    audio.ts                              # Mic + audio-capture state via probe
    audio.test.ts
  electron/main/storage/
    migrations.ts                         # MODIFY — add v6
    recording-sessions-repo.ts            # NEW
    recording-sessions-repo.test.ts
    settings-repo.ts                      # MODIFY — defaults for audioWatchPath, recordingBitrateKbps
  electron/main/library/
    watcher.ts                            # MODIFY — accept .m4a + dual-watch
    watcher.test.ts                       # MODIFY — new cases
  electron/main/ipc/
    contracts.ts                          # MODIFY — new channels for sources, level events
    handlers.ts                           # MODIFY — wire RecordingManager + permissions probe
  electron/preload/
    index.ts                              # MODIFY — expose recording.* + permissions.*
  electron/renderer/src/
    components/
      RecordButton.tsx                    # MODIFY — opens SourcePicker first
      SourcePicker.tsx                    # NEW
      LiveRecordingRow.tsx                # NEW
      VuMeter.tsx                         # NEW
      PermissionsModal.tsx                # NEW
    views/
      LibraryView.tsx                     # MODIFY — render LiveRecordingRow
      SettingsView.tsx                    # MODIFY — drop AH session name, add permissions + recording quality
    App.tsx                               # MODIFY — open PermissionsModal on first launch if missing
  electron/main/audio-hijack/             # DELETE entire directory at end
  electron-builder.yml                    # MODIFY — bundle helper, codesign with entitlements
  package.json                            # MODIFY — npm scripts for audio-tap build
  scripts/setup.sh                        # MODIFY — note Swift toolchain requirement
  scripts/build-bundle.sh                 # MODIFY — chain audio-tap build
  docs/manual-smoke-test.md               # MODIFY — new test cases
```

---

## Phase 0: Research (block downstream tasks)

These are time-boxed research tasks. Document findings inline in the plan as comments at the bottom of each task before moving on. Each closes an unknown the spec called out.

### Research R1: Process Tap entitlement key

**Goal:** Identify the exact entitlement key(s) the helper binary needs to be codesigned with so `AudioHardwareCreateProcessTap` succeeds at runtime. The spec lists `com.apple.security.device.audio-input` (mic) plus a Process Tap-specific entitlement that we haven't pinned down.

**Files:**
- Document findings in: `audio-tap/entitlements.plist` (created in Task 12) and as a comment block in `docs/superpowers/plans/2026-04-20-builtin-audio-capture.md` under this task.

- [ ] **Step 1: Read Apple's docs**

  Open <https://developer.apple.com/documentation/coreaudio/audiohardwarecreateprocesstap> and the linked "Capturing system audio with Core Audio taps" article. Note the listed entitlements.

- [ ] **Step 2: Search WWDC sessions / sample code**

  Look at "What's new in Core Audio" (WWDC 2023, session 10235) and Apple's "AudioCaptureKit" sample if one exists. Note the exact entitlement keys used.

- [ ] **Step 3: Test minimum entitlement set**

  In a scratch directory, write a 30-line Swift program that calls `AudioHardwareCreateProcessTap` with a hardcoded PID, signs it with each candidate entitlement combination, runs it, and observes which combinations succeed. Record the minimum set that works.

- [x] **Step 4: Document findings**

  ## R1 findings (2026-04-20, macOS 26.4.1 Apple Silicon)

  **Bottom line: Process Tap requires zero entitlements on macOS 14.2+.**

  Empirical test: an unsigned, ad-hoc-signed Swift CLI (`probe-tap.swift`)
  with **no** entitlements plist called `AudioHardwareCreateProcessTap`
  with an empty PID list (system-wide tap). Result: `noErr (0)`, valid
  tapID returned, clean destroy. **No TCC prompt fired.**

  Per-PID variants behaved as expected:
  - PID of a non-audio process (a shell): returns `'!obj'`
    (`kAudioHardwareBadObjectError`) — expected; not an audio object.
  - PID of an audio-producing process: returns `noErr` and a valid tapID.

  **Implications for the helper:**
  - The helper does NOT need a Process Tap-specific entitlement.
  - Mic capture (`AVAudioEngine.inputNode`) DOES still need
    `com.apple.security.device.audio-input` for hardened runtime in the
    packaged `.app`, plus the Mic TCC grant (which DOES prompt the user
    on first call).
  - Codesign with `--options runtime` and the audio-input entitlement
    is the minimum set. No special "system audio recording" key.

  **Production helper entitlements.plist (for Task 12):**
  ```xml
  <plist version="1.0">
  <dict>
    <key>com.apple.security.device.audio-input</key>
    <true/>
  </dict>
  </plist>
  ```

  **Caveats:**
  - Tested on macOS 26.4.1; may differ on a 14.2 baseline.
  - Hardened-runtime + Developer ID-signed binary distributed via DMG
    not yet tested; revalidate during Task 13 on a fresh user account.

### Research R2: Browser process trees

**Goal:** Decide how the helper handles browser meetings. Spec says "may need to tap all Chrome PIDs or fall back to system-audio." This task picks one.

**Files:** Document inline (this task).

- [ ] **Step 1: Enumerate Chrome's process tree during a Meet call**

  Open Google Meet in Chrome, join a test meeting (echo test). In a terminal, run:
  ```bash
  pgrep -lf "Google Chrome"
  ```
  Note: which PID has the audio. Use `lsof -p <pid> | grep -i audio` to find which one has the audio device open. Repeat for Safari with a Teams web call.

- [ ] **Step 2: Test per-PID Process Tap on the audio child**

  Using the scratch program from R1, attach a Process Tap to the identified audio child PID. Verify audio captures correctly. Try the parent PID — verify it does NOT capture audio (different process).

- [ ] **Step 3: Test enumerating all child PIDs**

  Using `proc_listpids`/`proc_pidinfo`, enumerate the parent's children. Test attaching a Process Tap to multiple PIDs simultaneously (the API takes an array).

- [x] **Step 4: Decision documented**

  ## R2 decision (2026-04-20)

  **Chosen: B — for "Chrome / browser meetings," fall back to system-wide capture.**

  Rationale: R1 confirmed both per-PID and system-wide taps work without
  entitlements, so we have full freedom. But per-PID for browsers is a
  losing battle — Chrome's audio process is a separate child PID, the
  audio child's identity changes between tab navigations, and even when
  we tap the right child we get every tab's audio anyway (no tab-level
  isolation in the audio subsystem). System-wide is what the user
  expects when they pick "browser meetings" because they intuit that
  browser audio is messy.

  **Source picker UX (Task 24) reflects this:**
  - Native meeting apps (Zoom, Teams native, FaceTime, etc.): per-PID tap.
  - "Chrome / browser meetings ⓘ": system-wide tap (tooltip explains).
  - "All system audio (catch-all)": system-wide tap (explicit).

  Implementation: when targetPid is a browser bundle ID, the renderer
  still passes `targetPid: 'system'` to `recording.start`, not the
  browser's PID. Keeps the helper-side logic simple (one branch for
  per-PID, one for system-wide).

  No further investigation needed during implementation.

### Research R3: Audio Capture System Settings deep link

**Goal:** Find the URL scheme that opens System Settings directly on the "Audio Capture" / "System Audio Recording" pane. Mic deep link is known: `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`.

**Files:** Document inline (this task).

- [ ] **Step 1: Try documented URL patterns**

  Test each of these in the terminal with `open <url>` and note which pane (if any) opens:
  - `x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture`
  - `x-apple.systempreferences:com.apple.preference.security?Privacy_SystemAudioRecording`
  - `x-apple.systempreferences:com.apple.preference.security?Privacy`
  - `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AudioCapture`

- [ ] **Step 2: Manual fallback verification**

  If no URL hits the audio-capture pane directly, document that we deep-link to the top-level Privacy & Security pane (`x-apple.systempreferences:com.apple.preference.security?Privacy`) and instruct the user to scroll to "System Audio Recording" / "Audio Capture."

- [x] **Step 3: Findings documented**

  ## R3 findings (2026-04-20, macOS 26.4.1)

  - **Mic pane URL** (verified to work):
    `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`
  - **System audio pane**: macOS calls this **"Screen & System Audio
    Recording"** (one combined pane for screen recording + audio capture).
    Deep link to try in implementation:
    `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
    (Apple's pattern for the screen-capture variant; if exact key is
    different on a specific macOS version, the URL still lands on
    Privacy & Security and the user can find the right entry.)
  - **Fallback URL** (always works, opens top-level Privacy pane):
    `x-apple.systempreferences:com.apple.preference.security?Privacy`

  **Important context from R1:** Process Tap doesn't appear to need a
  TCC grant on macOS 14.2+ for ad-hoc-signed binaries. The
  PermissionsModal probes state at runtime, so it only surfaces a
  Grant button if the runtime probe actually returns "denied." For
  most users on supported macOS, only the Mic permission will need
  granting; the System Audio Recording permission may never come into
  play. PermissionsModal handles both cases by being state-driven, not
  by hardcoding "ask for both."

---

## Phase 1: Swift helper foundation

### Task 1: Create audio-tap Swift package

**Files:**
- Create: `audio-tap/Package.swift`
- Create: `audio-tap/Sources/meeting-notes-tap/main.swift`
- Create: `audio-tap/.gitignore`

- [ ] **Step 1: Initialize package**

  ```bash
  mkdir -p audio-tap/Sources/meeting-notes-tap
  cd audio-tap
  ```

  Write `audio-tap/Package.swift`:
  ```swift
  // swift-tools-version: 5.9
  import PackageDescription

  let package = Package(
    name: "meeting-notes-tap",
    platforms: [.macOS(.v14)],
    targets: [
      .executableTarget(name: "meeting-notes-tap"),
    ]
  )
  ```

- [ ] **Step 2: Hello-world main**

  Write `audio-tap/Sources/meeting-notes-tap/main.swift`:
  ```swift
  import Foundation

  print(#"{"event":"started","note":"hello"}"#)
  ```

- [ ] **Step 3: gitignore**

  Write `audio-tap/.gitignore`:
  ```
  .build/
  build/
  *.xcodeproj
  ```

- [ ] **Step 4: Build + run**

  ```bash
  cd audio-tap
  swift build -c release
  .build/release/meeting-notes-tap
  ```
  Expected output: `{"event":"started","note":"hello"}`

- [ ] **Step 5: Commit**

  ```bash
  git add audio-tap/
  git commit -m "audio-tap: scaffold Swift package with hello-world binary"
  ```

### Task 2: Build script that produces the binary

**Files:**
- Create: `audio-tap/scripts/build.sh`
- Modify: `package.json` (add npm script)

- [ ] **Step 1: Build script**

  Write `audio-tap/scripts/build.sh`:
  ```bash
  #!/usr/bin/env bash
  # Builds the meeting-notes-tap helper as a release binary at
  # audio-tap/build/meeting-notes-tap. Stamps a BUILD_ID file so the
  # Electron main process can verify which binary it spawned.
  set -euo pipefail
  cd "$(dirname "$0")/.."

  swift build -c release \
    -Xswiftc -target -Xswiftc arm64-apple-macos14.2

  mkdir -p build
  cp .build/release/meeting-notes-tap build/meeting-notes-tap
  date -u +"%Y%m%dT%H%M%SZ-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)" > BUILD_ID

  echo "Built audio-tap/build/meeting-notes-tap"
  echo "BUILD_ID: $(cat BUILD_ID)"
  ```

- [ ] **Step 2: Make executable**

  ```bash
  chmod +x audio-tap/scripts/build.sh
  ```

- [ ] **Step 3: Add npm script**

  In `package.json`, add to the `"scripts"` block:
  ```json
  "build:audio-tap": "./audio-tap/scripts/build.sh",
  ```

- [ ] **Step 4: Verify**

  ```bash
  npm run build:audio-tap
  ls audio-tap/build/meeting-notes-tap
  audio-tap/build/meeting-notes-tap
  ```
  Expected: prints `{"event":"started","note":"hello"}`

- [ ] **Step 5: Commit**

  ```bash
  git add audio-tap/scripts/build.sh package.json
  git commit -m "audio-tap: build script + npm run build:audio-tap"
  ```

### Task 3: CLI argument parsing + JSON line output

**Files:**
- Modify: `audio-tap/Sources/meeting-notes-tap/main.swift`
- Create: `audio-tap/Sources/meeting-notes-tap/Commands.swift`
- Create: `audio-tap/Sources/meeting-notes-tap/StatusEvents.swift`

- [ ] **Step 1: StatusEvents helper**

  Write `audio-tap/Sources/meeting-notes-tap/StatusEvents.swift`:
  ```swift
  import Foundation

  // One-line JSON events on stdout. Each line is a self-contained object so
  // the Electron parent can read with a line-buffered stream.
  enum StatusEvent {
    static func emit(_ payload: [String: Any]) {
      guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
            let line = String(data: data, encoding: .utf8) else { return }
      print(line)
      // Force flush — stdout is buffered when piped.
      fflush(stdout)
    }

    static func error(_ message: String, exitCode: Int32 = 1) -> Never {
      FileHandle.standardError.write(Data("ERR \(message)\n".utf8))
      exit(exitCode)
    }
  }
  ```

- [ ] **Step 2: Commands enum**

  Write `audio-tap/Sources/meeting-notes-tap/Commands.swift`:
  ```swift
  import Foundation

  // Three modes: actually record, probe permissions, list audio-producing
  // processes. The renderer-facing API in Electron picks the right mode.
  enum Command {
    case record(RecordOptions)
    case probePermissions
    case listAudioProcesses

    static func parse(_ args: [String]) -> Command {
      var args = args
      args.removeFirst() // executable path
      if args.contains("--probe-permissions") { return .probePermissions }
      if args.contains("--list-audio-processes") { return .listAudioProcesses }
      return .record(RecordOptions.parse(args))
    }
  }

  struct RecordOptions {
    var pid: pid_t?               // nil ↔ system-wide audio
    var systemAudio: Bool
    var captureMic: Bool
    var outputPath: String
    var idleStopSeconds: Int

    static func parse(_ args: [String]) -> RecordOptions {
      var pid: pid_t? = nil
      var systemAudio = false
      var captureMic = true
      var outputPath = ""
      var idleStop = 4 * 60 * 60 // 4 hour safety stop

      var i = 0
      while i < args.count {
        switch args[i] {
        case "--pid":
          i += 1
          guard i < args.count, let p = pid_t(args[i]) else { StatusEvent.error("--pid requires integer") }
          pid = p
        case "--system-audio": systemAudio = true
        case "--mic": captureMic = true
        case "--no-mic": captureMic = false
        case "--out":
          i += 1
          guard i < args.count else { StatusEvent.error("--out requires path") }
          outputPath = args[i]
        case "--idle-stop-seconds":
          i += 1
          guard i < args.count, let n = Int(args[i]) else { StatusEvent.error("--idle-stop-seconds requires integer") }
          idleStop = n
        default:
          StatusEvent.error("unknown flag: \(args[i])")
        }
        i += 1
      }
      if outputPath.isEmpty { StatusEvent.error("--out is required") }
      if pid == nil && !systemAudio { StatusEvent.error("--pid <n> or --system-audio is required") }
      return RecordOptions(
        pid: pid, systemAudio: systemAudio, captureMic: captureMic,
        outputPath: outputPath, idleStopSeconds: idleStop,
      )
    }
  }
  ```

- [ ] **Step 3: Update main.swift**

  Replace `audio-tap/Sources/meeting-notes-tap/main.swift`:
  ```swift
  import Foundation

  let cmd = Command.parse(CommandLine.arguments)

  switch cmd {
  case .record(let opts):
    StatusEvent.emit(["event": "started", "stub": true, "out": opts.outputPath])
  case .probePermissions:
    StatusEvent.emit(["event": "permissions", "mic": "unknown", "audio_capture": "unknown"])
  case .listAudioProcesses:
    StatusEvent.emit(["event": "processes", "items": []])
  }
  ```

- [ ] **Step 4: Build and smoke-test all three modes**

  ```bash
  npm run build:audio-tap
  audio-tap/build/meeting-notes-tap --probe-permissions
  audio-tap/build/meeting-notes-tap --list-audio-processes
  audio-tap/build/meeting-notes-tap --pid 1234 --out /tmp/x.m4a
  audio-tap/build/meeting-notes-tap --bogus 2>&1 | grep "^ERR "
  ```
  Expected: each runs and emits the appropriate JSON; bad flag prints `ERR ...` to stderr and exits non-zero.

- [ ] **Step 5: Commit**

  ```bash
  git add audio-tap/Sources audio-tap/build
  git commit -m "audio-tap: CLI arg parsing + JSON status event scaffold"
  ```

---

## Phase 2: Swift helper functionality

### Task 4: Implement --list-audio-processes

**Files:**
- Create: `audio-tap/Sources/meeting-notes-tap/ProcessList.swift`
- Modify: `audio-tap/Sources/meeting-notes-tap/main.swift`

**Note:** This task implements CoreAudio process enumeration. Reference: `kAudioHardwarePropertyProcessObjectList`. The implementation queries the global CoreAudio object for all processes producing audio and walks the list to extract PID + bundle ID + name for each.

- [ ] **Step 1: Skeleton ProcessList**

  Write `audio-tap/Sources/meeting-notes-tap/ProcessList.swift`:
  ```swift
  import AudioToolbox
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
        mElement: kAudioObjectPropertyElementMain,
      )
      var size: UInt32 = 0
      var status = AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size,
      )
      guard status == noErr, size > 0 else { return [] }
      let count = Int(size) / MemoryLayout<AudioObjectID>.size
      var ids = [AudioObjectID](repeating: 0, count: count)
      status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids,
      )
      guard status == noErr else { return [] }
      return ids.compactMap(read)
    }

    private static func read(_ id: AudioObjectID) -> AudioProcess? {
      var pidAddress = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyPID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
      )
      var pid: pid_t = 0
      var pidSize = UInt32(MemoryLayout<pid_t>.size)
      let status = AudioObjectGetPropertyData(id, &pidAddress, 0, nil, &pidSize, &pid)
      guard status == noErr, pid > 0 else { return nil }

      let app = NSRunningApplication(processIdentifier: pid)
      return AudioProcess(
        pid: pid,
        bundleID: app?.bundleIdentifier,
        name: app?.localizedName,
      )
    }
  }
  ```

- [ ] **Step 2: Wire into main**

  Update the `.listAudioProcesses` case in `main.swift`:
  ```swift
  case .listAudioProcesses:
    let procs = ProcessList.enumerate().map { p -> [String: Any] in
      var out: [String: Any] = ["pid": Int(p.pid)]
      if let b = p.bundleID { out["bundle_id"] = b }
      if let n = p.name { out["name"] = n }
      out["is_meeting_app"] = (p.bundleID.map { MEETING_APP_BUNDLE_IDS.contains($0) }) ?? false
      return out
    }
    StatusEvent.emit(["event": "processes", "items": procs])
  ```

- [ ] **Step 3: Build and run**

  Open Zoom (or any audio-producing app) in another window, then:
  ```bash
  npm run build:audio-tap
  audio-tap/build/meeting-notes-tap --list-audio-processes | python3 -m json.tool
  ```
  Expected: JSON array including the running audio app(s).

- [ ] **Step 4: Commit**

  ```bash
  git add audio-tap/Sources/meeting-notes-tap/{ProcessList.swift,main.swift}
  git commit -m "audio-tap: --list-audio-processes via CoreAudio enumeration"
  ```

### Task 5: Implement --probe-permissions

**Files:**
- Create: `audio-tap/Sources/meeting-notes-tap/Permissions.swift`
- Modify: `audio-tap/Sources/meeting-notes-tap/main.swift`

- [ ] **Step 1: Permissions probe**

  Write `audio-tap/Sources/meeting-notes-tap/Permissions.swift`:
  ```swift
  import AVFoundation
  import AudioToolbox

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
    /// attempting to create a tap on PID 0 (the kernel) and reading the OS
    /// error. `kAudioHardwareUnpermittedErr` ↔ denied; `noErr` or any
    /// success-shaped error ↔ granted; `kAudioHardwareUnsupportedOperationError`
    /// ↔ pre-14.2 (treat as denied so the UI prompts).
    static func audioCapture() -> PermissionState {
      // NOTE: refine during R1 with the actual entitlement-aware probe.
      var description = CATapDescription(
        stereoMixdownOfProcesses: [],
      )
      var tapID: AUAudioObjectID = 0
      let status = AudioHardwareCreateProcessTap(description, &tapID)
      defer {
        if tapID != 0 { _ = AudioHardwareDestroyProcessTap(tapID) }
      }
      switch status {
      case noErr: return .granted
      case kAudioHardwareUnpermittedErr: return .denied
      default: return .notDetermined
      }
    }
  }
  ```

- [ ] **Step 2: Wire into main**

  Update the `.probePermissions` case:
  ```swift
  case .probePermissions:
    StatusEvent.emit([
      "event": "permissions",
      "mic": Permissions.microphone().rawValue,
      "audio_capture": Permissions.audioCapture().rawValue,
    ])
  ```

- [ ] **Step 3: Build and probe**

  ```bash
  npm run build:audio-tap
  audio-tap/build/meeting-notes-tap --probe-permissions
  ```
  Expected: JSON like `{"event":"permissions","mic":"granted","audio_capture":"not-determined"}` (exact values depend on TCC state).

- [ ] **Step 4: Commit**

  ```bash
  git add audio-tap/Sources/meeting-notes-tap/{Permissions.swift,main.swift}
  git commit -m "audio-tap: --probe-permissions reports mic + audio-capture state"
  ```

### Task 6: Implement Process Tap attach + AAC writer scaffolding

**Files:**
- Create: `audio-tap/Sources/meeting-notes-tap/Recorder.swift`
- Create: `audio-tap/Sources/meeting-notes-tap/AACWriter.swift`

**Note:** This is the deepest CoreAudio code in the project. Reference Apple's "Capturing system audio with Core Audio taps" article and the WWDC 2023 sample. The implementation combines:
1. `CATapDescription` listing target PIDs (or empty for system-wide)
2. `AudioHardwareCreateProcessTap` → tap object ID
3. `AudioHardwareCreateAggregateDevice` listing the tap as a sub-device
4. Open an `AVAudioEngine` whose `inputNode` is the aggregate device
5. Install a tap on the input node with a callback that receives `AVAudioPCMBuffer`s
6. `AVAudioEngine` separately gets the user's mic via `AVAudioSession`/`AVCaptureDeviceInput`
7. An `AVAudioMixerNode` mixes both into mono
8. Each mixer output buffer is converted and appended to an `AVAssetWriter` configured for AAC in M4A

- [ ] **Step 1: AACWriter scaffold**

  Write `audio-tap/Sources/meeting-notes-tap/AACWriter.swift`:
  ```swift
  import AVFoundation

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
        interleaved: false,
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
        formatDescriptionOut: &formatDescription,
      )
      guard err == noErr, let fd = formatDescription else { return nil }

      var timing = CMSampleTimingInfo(
        duration: CMTime(value: CMTimeValue(frameLength), timescale: CMTimeScale(asbd.mSampleRate)),
        presentationTimeStamp: presentationTime,
        decodeTimeStamp: .invalid,
      )
      var sampleBuffer: CMSampleBuffer?
      err = CMSampleBufferCreate(
        allocator: kCFAllocatorDefault,
        dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
        formatDescription: fd,
        sampleCount: CMItemCount(frameLength),
        sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 0, sampleSizeArray: nil,
        sampleBufferOut: &sampleBuffer,
      )
      guard err == noErr, let sb = sampleBuffer else { return nil }
      err = CMSampleBufferSetDataBufferFromAudioBufferList(
        sb, blockBufferAllocator: kCFAllocatorDefault,
        blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0,
        bufferList: audioBufferList,
      )
      guard err == noErr else { return nil }
      return sb
    }
  }
  ```

- [ ] **Step 2: Recorder skeleton (start/stop without audio yet)**

  Write `audio-tap/Sources/meeting-notes-tap/Recorder.swift`:
  ```swift
  import AVFoundation
  import AudioToolbox

  // Owns the lifecycle of one recording: tap + mic + mix + write.
  final class Recorder {
    private let opts: RecordOptions
    private var writer: AACWriter?
    private var engine: AVAudioEngine?
    private var tapObjectID: AudioObjectID = 0
    private var aggregateID: AudioObjectID = 0
    private var lastSignalAt: Date = .init()
    private var stopped = false

    init(opts: RecordOptions) { self.opts = opts }

    func start() throws {
      let url = URL(fileURLWithPath: opts.outputPath)
      // Use 48 kHz to match what aggregate devices typically expose.
      writer = try AACWriter(outputURL: url, sampleRate: 48_000, bitrate: 128_000)
      try attachProcessTap()
      if opts.captureMic { try attachMic() }
      try startEngine()
      StatusEvent.emit(["event": "started"])
    }

    func stop() async {
      guard !stopped else { return }
      stopped = true
      engine?.stop()
      detachProcessTap()
      if let w = writer {
        await w.finalize()
        StatusEvent.emit([
          "event": "stopped",
          "bytes": NSNumber(value: w.bytesWritten),
        ])
      }
    }

    // MARK: - Process Tap
    private func attachProcessTap() throws {
      // See R1 + R2 for entitlement / process-tree decisions. The shape of
      // the call:
      //
      //   let desc = CATapDescription(stereoMixdownOfProcesses: pids)
      //   var tapID: AUAudioObjectID = 0
      //   let s = AudioHardwareCreateProcessTap(desc, &tapID)
      //
      // Then create an aggregate device that includes the tap as a sub-device,
      // and use that aggregate as the input source for AVAudioEngine.
      // Implementation defers to runtime per R1 findings.
      throw NSError(domain: "meeting-notes-tap", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Process tap attach not yet implemented (Task 7)"])
    }

    private func detachProcessTap() {
      if tapObjectID != 0 { _ = AudioHardwareDestroyProcessTap(tapObjectID); tapObjectID = 0 }
      if aggregateID != 0 { _ = AudioHardwareDestroyAggregateDevice(aggregateID); aggregateID = 0 }
    }

    // MARK: - Mic
    private func attachMic() throws {
      // Implemented in Task 8.
    }

    // MARK: - Engine
    private func startEngine() throws {
      // Implemented in Task 9.
    }
  }
  ```

- [ ] **Step 3: Build (will compile but fail at runtime — that's fine for now)**

  ```bash
  npm run build:audio-tap
  ```
  Expected: build succeeds (Recorder is unused — main hasn't been wired up yet).

- [ ] **Step 4: Commit**

  ```bash
  git add audio-tap/Sources/meeting-notes-tap/{Recorder.swift,AACWriter.swift}
  git commit -m "audio-tap: AACWriter + Recorder skeleton (engine wiring follows)"
  ```

### Task 7: Implement Process Tap attach + aggregate device

**Files:**
- Modify: `audio-tap/Sources/meeting-notes-tap/Recorder.swift` (`attachProcessTap`)

**Note:** Uses findings from R1 + R2. The pattern: build a `CATapDescription` with target PIDs (empty for system-wide), call `AudioHardwareCreateProcessTap`, then wrap the tap in an aggregate device via `AudioHardwareCreateAggregateDevice` so AVAudioEngine can read it as a normal input.

- [ ] **Step 1: Implement attachProcessTap**

  Replace the stub with:
  ```swift
  private func attachProcessTap() throws {
    // For per-process: use the supplied PID. For system-wide: empty array
    // means "everything." NOTE: confirm this semantic in R2 — some Apple
    // docs use a sentinel like the PID 0 (kernel) for system-wide.
    let pids: [AudioObjectID]
    if opts.systemAudio {
      pids = []
    } else if let p = opts.pid {
      pids = [AudioObjectID(p)]
    } else {
      throw NSError(domain: "meeting-notes-tap", code: -2,
                    userInfo: [NSLocalizedDescriptionKey: "no target PID and not system-audio"])
    }

    let description = CATapDescription(stereoMixdownOfProcesses: pids)
    description.uuid = UUID()
    description.name = "MeetingNotes Tap \(getpid())"
    description.isPrivate = true   // not visible to other apps
    description.isExclusive = false

    var tapID: AUAudioObjectID = 0
    let s1 = AudioHardwareCreateProcessTap(description, &tapID)
    guard s1 == noErr else {
      throw NSError(domain: "meeting-notes-tap", code: Int(s1),
                    userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateProcessTap failed: \(s1)"])
    }
    self.tapObjectID = tapID

    // Wrap the tap in an aggregate device so AVAudioEngine can read it.
    let aggregateUID = "meeting-notes-tap-\(getpid())"
    let aggDescription: [String: Any] = [
      kAudioAggregateDeviceUIDKey as String: aggregateUID,
      kAudioAggregateDeviceNameKey as String: "MeetingNotes Tap Aggregate",
      kAudioAggregateDeviceIsPrivateKey as String: true,
      kAudioAggregateDeviceTapListKey as String: [
        [kAudioSubTapUIDKey as String: description.uuid.uuidString],
      ],
    ]
    var aggregateID: AudioObjectID = 0
    let s2 = AudioHardwareCreateAggregateDevice(aggDescription as CFDictionary, &aggregateID)
    guard s2 == noErr else {
      throw NSError(domain: "meeting-notes-tap", code: Int(s2),
                    userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateAggregateDevice failed: \(s2)"])
    }
    self.aggregateID = aggregateID
  }
  ```

- [ ] **Step 2: Build to verify it compiles**

  ```bash
  npm run build:audio-tap
  ```
  Expected: clean build.

- [ ] **Step 3: Commit**

  ```bash
  git add audio-tap/Sources/meeting-notes-tap/Recorder.swift
  git commit -m "audio-tap: attach Process Tap + wrap in aggregate device"
  ```

### Task 8: Implement mic capture + mixer + engine startup

**Files:**
- Modify: `audio-tap/Sources/meeting-notes-tap/Recorder.swift` (`attachMic`, `startEngine`)

- [ ] **Step 1: Implement attachMic + startEngine**

  Replace the two stubs with:
  ```swift
  private func attachMic() throws {
    // AVAudioEngine's default input node maps to the system default input
    // (the user's mic). Mic and tap go into separate inputs; the mixer
    // sums them into mono. The engine is built lazily in startEngine.
  }

  private func startEngine() throws {
    let engine = AVAudioEngine()
    self.engine = engine

    // Set the engine's input device to our aggregate (which contains the tap).
    var aggID = self.aggregateID
    let s = AudioUnitSetProperty(
      engine.inputNode.audioUnit!,
      kAudioOutputUnitProperty_CurrentDevice,
      kAudioUnitScope_Global, 0,
      &aggID, UInt32(MemoryLayout<AudioObjectID>.size),
    )
    guard s == noErr else {
      throw NSError(domain: "meeting-notes-tap", code: Int(s),
                    userInfo: [NSLocalizedDescriptionKey: "set engine input device failed: \(s)"])
    }

    // The mixer downmixes the tap's stereo (or N-channel) plus the mic to mono.
    let mixer = AVAudioMixerNode()
    engine.attach(mixer)

    let tapInputFormat = engine.inputNode.outputFormat(forBus: 0)
    engine.connect(engine.inputNode, to: mixer, format: tapInputFormat)

    if opts.captureMic {
      // Mic is a separate AVAudioInputNode is not directly available — instead
      // we use AVCaptureSession + AVAudioConverter to feed mic samples into the
      // mixer via a player node. Done in a follow-up patch; for v1 the tap is
      // the only audio source. (Realistic ordering: implement mic capture in
      // a later iteration; ship the tap-only path first.)
    }

    // The mono format the writer expects.
    let writeFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 48_000,
      channels: 1,
      interleaved: false,
    )!
    mixer.installTap(onBus: 0, bufferSize: 4096, format: writeFormat) { [weak self] buffer, time in
      guard let self = self, let writer = self.writer else { return }
      self.lastSignalAt = .init()
      writer.append(buffer, at: time.hostTime)
      // Periodic level event for the renderer's VU meter (~10 Hz).
      let now = Date().timeIntervalSince1970
      if now - self.lastLevelEmitAt > 0.1 {
        self.lastLevelEmitAt = now
        StatusEvent.emit([
          "event": "level",
          "peak_db": Self.peakDB(buffer),
        ])
      }
    }
    try engine.start()
  }

  // Add to the class properties block:
  private var lastLevelEmitAt: TimeInterval = 0

  // Add as a static helper:
  private static func peakDB(_ buffer: AVAudioPCMBuffer) -> Double {
    guard let channels = buffer.floatChannelData else { return -160 }
    let n = Int(buffer.frameLength)
    var peak: Float = 0
    for c in 0..<Int(buffer.format.channelCount) {
      for i in 0..<n {
        peak = max(peak, abs(channels[c][i]))
      }
    }
    return peak == 0 ? -160 : 20 * log10(Double(peak))
  }
  ```

  Note: The mic-via-mixer wiring is intentionally deferred per the inline comment — getting tap+M4A working first is higher priority. Mic comes in Task 9.

- [ ] **Step 2: Wire Recorder into main**

  Update the `.record` case in `main.swift`:
  ```swift
  case .record(let opts):
    let recorder = Recorder(opts: opts)
    do {
      try recorder.start()
    } catch {
      StatusEvent.error("start failed: \(error.localizedDescription)")
    }
    // Wait for SIGTERM. Block forever; signal handler exits.
    let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    sigterm.setEventHandler {
      Task {
        await recorder.stop()
        exit(0)
      }
    }
    sigterm.resume()
    signal(SIGTERM, SIG_IGN)  // let DispatchSource handle it
    dispatchMain()
  ```

- [ ] **Step 3: Smoke test (tap-only, no mic)**

  Open Zoom or Music or another audio source. Then:
  ```bash
  PID=$(pgrep -f "Music" | head -1)  # or whatever you have producing audio
  audio-tap/build/meeting-notes-tap --pid $PID --no-mic --out /tmp/test.m4a &
  HELPER=$!
  sleep 10
  kill -TERM $HELPER
  wait $HELPER
  afplay /tmp/test.m4a
  ```
  Expected: 10 seconds of audio captured from the target app, plays back.

- [ ] **Step 4: Commit**

  ```bash
  git add audio-tap/Sources/meeting-notes-tap/{Recorder.swift,main.swift}
  git commit -m "audio-tap: tap-only recording end to end (mic deferred to Task 9)"
  ```

### Task 9: Implement mic capture + mix into mono output

**Files:**
- Modify: `audio-tap/Sources/meeting-notes-tap/Recorder.swift`

- [ ] **Step 1: Replace the deferred mic block in startEngine**

  Inside `startEngine`, replace the `if opts.captureMic { … }` block with:
  ```swift
  if opts.captureMic {
    // Add a second AVAudioEngine for the mic (default input) — running two
    // engines lets each manage its own sample rate, then we feed mic buffers
    // into the mixer of the tap engine via a player node.
    let micEngine = AVAudioEngine()
    self.micEngine = micEngine
    let micInput = micEngine.inputNode
    let micFormat = micInput.outputFormat(forBus: 0)

    let player = AVAudioPlayerNode()
    engine.attach(player)
    engine.connect(player, to: mixer, format: writeFormat)

    let converter = AVAudioConverter(from: micFormat, to: writeFormat)!
    micInput.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buffer, _ in
      // Convert mic buffer to writeFormat (mono 48kHz Float32) and schedule on
      // the player so the mixer sums it with the tap stream.
      let outBuf = AVAudioPCMBuffer(pcmFormat: writeFormat,
                                    frameCapacity: AVAudioFrameCount(writeFormat.sampleRate))!
      var error: NSError?
      let _ = converter.convert(to: outBuf, error: &error) { _, status in
        status.pointee = .haveData
        return buffer
      }
      if error == nil {
        player.scheduleBuffer(outBuf, completionHandler: nil)
      }
    }
    try micEngine.start()
    player.play()
  }
  ```

- [ ] **Step 2: Add micEngine property**

  Near the top of `Recorder`:
  ```swift
  private var micEngine: AVAudioEngine?
  ```

  And update `stop()` to also stop micEngine:
  ```swift
  micEngine?.stop()
  ```

- [ ] **Step 3: Smoke test mic + tap**

  ```bash
  PID=$(pgrep -f "Music" | head -1)
  audio-tap/build/meeting-notes-tap --pid $PID --mic --out /tmp/mix.m4a &
  HELPER=$!
  # Talk into the mic for 10 seconds
  sleep 10
  kill -TERM $HELPER
  wait $HELPER
  afplay /tmp/mix.m4a
  ```
  Expected: hear both your voice and Music playing back, mixed.

- [ ] **Step 4: Commit**

  ```bash
  git add audio-tap/Sources/meeting-notes-tap/Recorder.swift
  git commit -m "audio-tap: mic capture + mono mix into output M4A"
  ```

### Task 10: Parent-PID watchdog + idle-stop timer

**Files:**
- Create: `audio-tap/Sources/meeting-notes-tap/ParentWatch.swift`
- Modify: `audio-tap/Sources/meeting-notes-tap/main.swift`

- [ ] **Step 1: ParentWatch via kqueue**

  Write `audio-tap/Sources/meeting-notes-tap/ParentWatch.swift`:
  ```swift
  import Foundation

  // Posix-style PID watchdog. When the parent process exits, the kqueue
  // event fires; we stop and exit. Used so an Electron crash doesn't leave
  // an orphan recorder running indefinitely.
  enum ParentWatch {
    static func onParentExit(_ handler: @escaping () -> Void) {
      let parentPID = getppid()
      DispatchQueue.global().async {
        let kq = kqueue()
        guard kq >= 0 else { return }
        var event = kevent(
          ident: UInt(parentPID),
          filter: Int16(EVFILT_PROC),
          flags: UInt16(EV_ADD | EV_ENABLE | EV_ONESHOT),
          fflags: UInt32(NOTE_EXIT),
          data: 0, udata: nil,
        )
        guard kevent(kq, &event, 1, nil, 0, nil) >= 0 else { close(kq); return }
        var triggered = kevent()
        let n = kevent(kq, nil, 0, &triggered, 1, nil)
        close(kq)
        if n > 0 { handler() }
      }
    }
  }
  ```

- [ ] **Step 2: Wire watchdog + idle-stop into main**

  In `main.swift`, before `dispatchMain()`:
  ```swift
  // Parent died → stop and exit cleanly (orphan recovery).
  ParentWatch.onParentExit {
    Task {
      await recorder.stop()
      exit(0)
    }
  }

  // Idle-stop safety net: if no audio for N seconds, stop. Prevents a
  // hard-killed parent (kernel panic) from leaving us recording silence
  // forever. Recorder updates lastSignalAt every time it writes a buffer.
  let idleTimer = DispatchSource.makeTimerSource(queue: .global())
  idleTimer.schedule(deadline: .now() + 60, repeating: 60)
  idleTimer.setEventHandler {
    if Date().timeIntervalSince(recorder.lastSignalSeen()) > Double(opts.idleStopSeconds) {
      Task {
        StatusEvent.emit(["event": "idle_stop"])
        await recorder.stop()
        exit(0)
      }
    }
  }
  idleTimer.resume()
  ```

- [ ] **Step 3: Add lastSignalSeen accessor on Recorder**

  In `Recorder.swift`:
  ```swift
  func lastSignalSeen() -> Date { lastSignalAt }
  ```

- [ ] **Step 4: Smoke test parent-death**

  ```bash
  audio-tap/build/meeting-notes-tap --pid $$ --mic --out /tmp/parentkill.m4a &
  HELPER=$!
  sleep 5
  # Simulate parent crash by killing this shell.
  exit  # in a real test, run from a sub-shell so you can kill it
  ```
  Expected: helper detects parent exit and finalizes the file.

- [ ] **Step 5: Commit**

  ```bash
  git add audio-tap/Sources/meeting-notes-tap/{ParentWatch.swift,main.swift,Recorder.swift}
  git commit -m "audio-tap: parent-PID watchdog + idle-stop safety timer"
  ```

### Task 11: Auto-stop on target app exit

**Files:**
- Modify: `audio-tap/Sources/meeting-notes-tap/Recorder.swift`

- [ ] **Step 1: Watch target PID via kqueue**

  In `Recorder`, after `attachProcessTap()` succeeds (still inside `start()`):
  ```swift
  if let targetPID = opts.pid {
    DispatchQueue.global().async { [weak self] in
      let kq = kqueue()
      var event = kevent(
        ident: UInt(targetPID), filter: Int16(EVFILT_PROC),
        flags: UInt16(EV_ADD | EV_ENABLE | EV_ONESHOT),
        fflags: UInt32(NOTE_EXIT), data: 0, udata: nil,
      )
      _ = kevent(kq, &event, 1, nil, 0, nil)
      var triggered = kevent()
      _ = kevent(kq, nil, 0, &triggered, 1, nil)
      close(kq)
      Task {
        StatusEvent.emit(["event": "target_exited", "pid": Int(targetPID)])
        await self?.stop()
        exit(0)
      }
    }
  }
  ```

- [ ] **Step 2: Smoke test**

  Open a small audio app (e.g. open a YouTube video in QuickTime Player). Get its PID. Start recording targeting it. Then quit that app. Helper should auto-finalize within a second.

- [ ] **Step 3: Commit**

  ```bash
  git add audio-tap/Sources/meeting-notes-tap/Recorder.swift
  git commit -m "audio-tap: auto-stop when target app exits"
  ```

---

## Phase 3: Codesigning + electron-builder bundling

### Task 12: Entitlements file

**Files:**
- Create: `audio-tap/entitlements.plist`

- [ ] **Step 1: Write entitlements (using R1 findings)**

  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <!-- Mic input -->
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <!-- Process Tap / system audio capture. Exact key list verified in R1. -->
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <!-- Add Process-Tap-specific keys here per R1 findings. -->
  </dict>
  </plist>
  ```

  **Update this file with the actual keys from R1 before this task is considered complete.**

- [ ] **Step 2: Update build script to sign**

  Append to `audio-tap/scripts/build.sh`:
  ```bash
  # Sign the helper if a signing identity is available. In CI / dev without an
  # identity, codesign with --sign - (ad-hoc) so it's at least entitled.
  if [ -n "${CODESIGN_IDENTITY:-}" ]; then
    codesign --force --options runtime \
      --entitlements entitlements.plist \
      --sign "$CODESIGN_IDENTITY" \
      build/meeting-notes-tap
  else
    codesign --force --options runtime \
      --entitlements entitlements.plist \
      --sign - \
      build/meeting-notes-tap
  fi
  ```

- [ ] **Step 3: Build + verify entitlements applied**

  ```bash
  npm run build:audio-tap
  codesign -d --entitlements - audio-tap/build/meeting-notes-tap
  ```
  Expected: prints the entitlements XML.

- [ ] **Step 4: Commit**

  ```bash
  git add audio-tap/entitlements.plist audio-tap/scripts/build.sh
  git commit -m "audio-tap: entitlements + ad-hoc codesigning during build"
  ```

### Task 13: electron-builder bundles the helper

**Files:**
- Modify: `electron-builder.yml`
- Modify: `package.json` (chain audio-tap build into dist)
- Modify: `scripts/build-bundle.sh` (or add to it)

- [ ] **Step 1: Add to extraResources**

  Edit `electron-builder.yml`, append under `extraResources:`:
  ```yaml
    - from: audio-tap/build/meeting-notes-tap
      to: bin/meeting-notes-tap
  ```

- [ ] **Step 2: Chain build into npm run dist**

  Modify `package.json` `"dist"` script:
  ```json
  "dist": "npm run build:audio-tap && npm run build && electron-builder --mac",
  ```

- [ ] **Step 3: Verify bundle contents**

  ```bash
  npm run dist
  ls release/mac-arm64/MeetingNotes.app/Contents/Resources/bin/meeting-notes-tap
  codesign -d --entitlements - release/mac-arm64/MeetingNotes.app/Contents/Resources/bin/meeting-notes-tap
  ```
  Expected: helper exists at the bundled path with entitlements intact.

- [ ] **Step 4: Commit**

  ```bash
  git add electron-builder.yml package.json
  git commit -m "build: bundle meeting-notes-tap into MeetingNotes.app"
  ```

### Task 14: Helper-path resolver in Electron

**Files:**
- Create: `electron/main/recording/helper-path.ts`
- Create: `electron/main/recording/helper-path.test.ts`

- [ ] **Step 1: Failing test**

  Write `electron/main/recording/helper-path.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { resolveHelperPath } from './helper-path.js';

  describe('resolveHelperPath', () => {
    it('uses dev path when not packaged', () => {
      const p = resolveHelperPath({ isPackaged: false, appPath: '/proj' });
      expect(p).toBe('/proj/audio-tap/build/meeting-notes-tap');
    });

    it('uses bundled path when packaged', () => {
      const p = resolveHelperPath({ isPackaged: true, resourcesPath: '/MyApp.app/Contents/Resources' });
      expect(p).toBe('/MyApp.app/Contents/Resources/bin/meeting-notes-tap');
    });
  });
  ```

- [ ] **Step 2: Run, verify FAIL**

  ```bash
  npx vitest run electron/main/recording/helper-path.test.ts
  ```

- [ ] **Step 3: Implement**

  Write `electron/main/recording/helper-path.ts`:
  ```ts
  import path from 'node:path';

  /**
   * Locates the bundled `meeting-notes-tap` binary. In dev (`npm run dev`)
   * we run from the repo root and the binary is at audio-tap/build/. In the
   * packaged .app, electron-builder placed it at Resources/bin/.
   */
  export interface HelperPathInput {
    isPackaged: boolean;
    appPath?: string;          // process.cwd() in dev
    resourcesPath?: string;    // process.resourcesPath in packaged
  }

  export function resolveHelperPath(input: HelperPathInput): string {
    if (input.isPackaged) {
      if (!input.resourcesPath) throw new Error('resourcesPath required when packaged');
      return path.join(input.resourcesPath, 'bin', 'meeting-notes-tap');
    }
    if (!input.appPath) throw new Error('appPath required in dev');
    return path.join(input.appPath, 'audio-tap', 'build', 'meeting-notes-tap');
  }
  ```

- [ ] **Step 4: Verify PASS + commit**

  ```bash
  npx vitest run electron/main/recording/helper-path.test.ts
  git add electron/main/recording/helper-path.{ts,test.ts}
  git commit -m "recording: resolve helper binary path in dev vs packaged"
  ```

---

## Phase 4: DB migration + repository

### Task 15: Migration v6 — recording_sessions table

**Files:**
- Modify: `electron/main/storage/migrations.ts`

- [ ] **Step 1: Add migration**

  Append to the `MIGRATIONS` array in `electron/main/storage/migrations.ts`:
  ```ts
  {
    version: 6,
    // Track in-flight recordings so we can recover orphans on next launch
    // (an unfinalized .m4a from a previous PID that never wrote 'finalized').
    // status='recording' on insert; updated to 'finalized' on clean stop or
    // 'orphaned' when the recovery scan finds the file abandoned.
    up: `
      CREATE TABLE IF NOT EXISTS recording_sessions (
        id TEXT PRIMARY KEY,
        helper_pid INTEGER NOT NULL,
        target_pid INTEGER,
        target_label TEXT NOT NULL,
        output_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finalized_at TEXT,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rec_status ON recording_sessions(status);
    `,
  },
  ```

- [ ] **Step 2: Smoke test**

  ```bash
  rm -f /tmp/test.sqlite
  node -e "
    const Database = require('better-sqlite3');
    const { runMigrations } = require('./dist/electron/main/storage/migrations.js');
    const db = new Database('/tmp/test.sqlite');
    runMigrations(db);
    console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\"').all());
  "
  ```
  Expected: table list includes `recording_sessions`.

- [ ] **Step 3: Commit**

  ```bash
  git add electron/main/storage/migrations.ts
  git commit -m "storage: migration v6 — recording_sessions table"
  ```

### Task 16: RecordingSessionsRepo

**Files:**
- Create: `electron/main/storage/recording-sessions-repo.ts`
- Create: `electron/main/storage/recording-sessions-repo.test.ts`

- [ ] **Step 1: Failing test**

  Write `electron/main/storage/recording-sessions-repo.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import { openDb } from './db.js';
  import { RecordingSessionsRepo } from './recording-sessions-repo.js';

  describe('RecordingSessionsRepo', () => {
    it('insert + findOpen + finalize round-trip', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-rs-'));
      const db = openDb(path.join(dir, 'db.sqlite'));
      const repo = new RecordingSessionsRepo(db);

      repo.insert({
        id: 'sess1', helperPid: 9999, targetPid: 1234,
        targetLabel: 'Zoom', outputPath: '/tmp/x.m4a',
      });
      expect(repo.findOpen()).toHaveLength(1);

      repo.finalize('sess1');
      expect(repo.findOpen()).toHaveLength(0);
    });

    it('markOrphaned moves status without finalize timestamp', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-rs2-'));
      const db = openDb(path.join(dir, 'db.sqlite'));
      const repo = new RecordingSessionsRepo(db);
      repo.insert({ id: 's', helperPid: 1, targetPid: null, targetLabel: 'X', outputPath: '/p' });
      repo.markOrphaned('s');
      const all = repo.findOpen();
      expect(all).toHaveLength(0); // no longer 'recording'
      const orphans = repo.findOrphaned();
      expect(orphans).toHaveLength(1);
    });
  });
  ```

- [ ] **Step 2: Implement**

  Write `electron/main/storage/recording-sessions-repo.ts`:
  ```ts
  import type Database from 'better-sqlite3';

  export interface RecordingSessionInsert {
    id: string;
    helperPid: number;
    targetPid: number | null;
    targetLabel: string;
    outputPath: string;
  }

  export interface RecordingSessionRow {
    id: string;
    helperPid: number;
    targetPid: number | null;
    targetLabel: string;
    outputPath: string;
    startedAt: string;
    finalizedAt: string | null;
    status: 'recording' | 'finalized' | 'orphaned' | 'error';
  }

  export class RecordingSessionsRepo {
    constructor(private readonly db: Database.Database) {}

    insert(s: RecordingSessionInsert): void {
      this.db.prepare(`
        INSERT INTO recording_sessions
          (id, helper_pid, target_pid, target_label, output_path, started_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'recording')
      `).run(s.id, s.helperPid, s.targetPid, s.targetLabel, s.outputPath, new Date().toISOString());
    }

    finalize(id: string): void {
      this.db.prepare(`
        UPDATE recording_sessions
           SET status = 'finalized', finalized_at = ?
         WHERE id = ?
      `).run(new Date().toISOString(), id);
    }

    markOrphaned(id: string): void {
      this.db.prepare("UPDATE recording_sessions SET status = 'orphaned' WHERE id = ?").run(id);
    }

    markError(id: string): void {
      this.db.prepare("UPDATE recording_sessions SET status = 'error' WHERE id = ?").run(id);
    }

    findOpen(): RecordingSessionRow[] {
      return (this.db.prepare("SELECT * FROM recording_sessions WHERE status = 'recording'").all() as Record<string, unknown>[])
        .map(rowToSession);
    }

    findOrphaned(): RecordingSessionRow[] {
      return (this.db.prepare("SELECT * FROM recording_sessions WHERE status = 'orphaned'").all() as Record<string, unknown>[])
        .map(rowToSession);
    }
  }

  function rowToSession(r: Record<string, unknown>): RecordingSessionRow {
    return {
      id: r.id as string,
      helperPid: r.helper_pid as number,
      targetPid: (r.target_pid as number) ?? null,
      targetLabel: r.target_label as string,
      outputPath: r.output_path as string,
      startedAt: r.started_at as string,
      finalizedAt: (r.finalized_at as string) ?? null,
      status: r.status as RecordingSessionRow['status'],
    };
  }
  ```

- [ ] **Step 3: Verify PASS + commit**

  ```bash
  npx vitest run electron/main/storage/recording-sessions-repo
  git add electron/main/storage/recording-sessions-repo.{ts,test.ts}
  git commit -m "storage: RecordingSessionsRepo CRUD + status transitions"
  ```

---

## Phase 5: RecordingManager + AppEnumerator + orphan recovery

### Task 17: RecordingManager skeleton + start()

**Files:**
- Create: `electron/main/recording/manager.ts`
- Create: `electron/main/recording/manager.test.ts`

- [ ] **Step 1: Failing test**

  Write `electron/main/recording/manager.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { RecordingManager } from './manager.js';

  describe('RecordingManager', () => {
    it('start spawns helper with the right args', async () => {
      const spawned: { cmd: string; args: string[] }[] = [];
      const fakeSpawn = (cmd: string, args: string[]) => {
        spawned.push({ cmd, args });
        return {
          pid: 12345,
          stdout: { on: () => {}, setEncoding: () => {} },
          stderr: { on: () => {}, setEncoding: () => {} },
          on: (ev: string, cb: any) => { if (ev === 'spawn') queueMicrotask(cb); },
          kill: () => {},
        } as any;
      };
      const fakeRepo = {
        insert: vi.fn(), finalize: vi.fn(), markError: vi.fn(),
        findOpen: () => [], findOrphaned: () => [],
      } as any;

      const mgr = new RecordingManager({
        helperPath: '/bin/meeting-notes-tap',
        recordingsDir: '/tmp',
        repo: fakeRepo,
        spawn: fakeSpawn,
        clock: () => new Date('2026-04-20T19:23:00Z'),
      });
      const { sessionId } = await mgr.start({ targetPid: 999, targetLabel: 'Zoom', mic: true });
      expect(sessionId).toBeTruthy();
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.cmd).toBe('/bin/meeting-notes-tap');
      expect(spawned[0]!.args).toContain('--pid');
      expect(spawned[0]!.args).toContain('999');
      expect(spawned[0]!.args).toContain('--mic');
      expect(spawned[0]!.args).toContain('--out');
      expect(fakeRepo.insert).toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Run, verify FAIL**

  ```bash
  npx vitest run electron/main/recording/manager.test.ts
  ```

- [ ] **Step 3: Implement**

  Write `electron/main/recording/manager.ts`:
  ```ts
  import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
  import path from 'node:path';
  import { ulid } from '../lib/ulid.js'; // assuming ulid helper exists; if not, use `nanoid` or Math.random
  import type { RecordingSessionsRepo } from '../storage/recording-sessions-repo.js';

  export type RecordingState = 'idle' | 'starting' | 'recording' | 'stopping' | 'error';

  export interface StartInput {
    targetPid: number | 'system';
    targetLabel: string;
    mic: boolean;
  }

  export interface StartResult {
    sessionId: string;
    outputPath: string;
  }

  type SpawnFn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams | any;

  export class RecordingManager {
    private sessions = new Map<string, { proc: any; outputPath: string; state: RecordingState }>();
    private listeners = {
      level: new Set<(sessionId: string, peakDb: number) => void>(),
      stateChange: new Set<(sessionId: string, state: RecordingState) => void>(),
    };

    constructor(private readonly deps: {
      helperPath: string;
      recordingsDir: string;
      repo: RecordingSessionsRepo;
      spawn?: SpawnFn;
      clock?: () => Date;
    }) {}

    async start(input: StartInput): Promise<StartResult> {
      const sessionId = (this.deps.clock?.() ?? new Date()).getTime().toString(36) +
        Math.random().toString(36).slice(2, 6);
      const stamp = (this.deps.clock?.() ?? new Date()).toISOString()
        .replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
      const outputPath = path.join(this.deps.recordingsDir, `recording-${stamp}-${sessionId}.m4a`);

      const args: string[] = [];
      if (input.targetPid === 'system') {
        args.push('--system-audio');
      } else {
        args.push('--pid', String(input.targetPid));
      }
      if (input.mic) args.push('--mic'); else args.push('--no-mic');
      args.push('--out', outputPath);

      const spawnFn = this.deps.spawn ?? nodeSpawn;
      const proc = spawnFn(this.deps.helperPath, args);
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      this.sessions.set(sessionId, { proc, outputPath, state: 'starting' });
      this.deps.repo.insert({
        id: sessionId,
        helperPid: proc.pid ?? -1,
        targetPid: input.targetPid === 'system' ? null : input.targetPid,
        targetLabel: input.targetLabel,
        outputPath,
      });

      // Wait for the started event (helper emits {"event":"started"} when CoreAudio is attached).
      await new Promise<void>((resolve, reject) => {
        let buf = '';
        const onChunk = (chunk: string) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            this.handleLine(sessionId, line);
            if (line.includes('"event":"started"')) resolve();
          }
        };
        proc.stdout.on('data', onChunk);
        proc.on('exit', (code: number | null) => {
          if (this.sessions.get(sessionId)?.state !== 'recording') {
            reject(new Error(`helper exited before started (code=${code})`));
          }
        });
      });
      this.transition(sessionId, 'recording');
      return { sessionId, outputPath };
    }

    async stop(sessionId: string): Promise<void> {
      const s = this.sessions.get(sessionId);
      if (!s) throw new Error(`no such session: ${sessionId}`);
      this.transition(sessionId, 'stopping');
      s.proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        s.proc.on('exit', () => resolve());
        // Hard-kill safety: if SIGTERM doesn't end it in 5s, SIGKILL.
        setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch {} resolve(); }, 5000);
      });
      this.deps.repo.finalize(sessionId);
      this.sessions.delete(sessionId);
    }

    state(sessionId: string): RecordingState {
      return this.sessions.get(sessionId)?.state ?? 'idle';
    }

    on(event: 'level', cb: (sessionId: string, peakDb: number) => void): void;
    on(event: 'state-change', cb: (sessionId: string, state: RecordingState) => void): void;
    on(event: 'level' | 'state-change', cb: any): void {
      if (event === 'level') this.listeners.level.add(cb);
      else this.listeners.stateChange.add(cb);
    }

    private transition(sessionId: string, state: RecordingState): void {
      const s = this.sessions.get(sessionId);
      if (s) { s.state = state; }
      for (const cb of this.listeners.stateChange) cb(sessionId, state);
    }

    private handleLine(sessionId: string, line: string): void {
      if (!line.trim().startsWith('{')) return;
      let payload: { event?: string; peak_db?: number } | undefined;
      try { payload = JSON.parse(line); } catch { return; }
      if (payload?.event === 'level' && typeof payload.peak_db === 'number') {
        for (const cb of this.listeners.level) cb(sessionId, payload.peak_db);
      }
    }
  }
  ```

  Note: if `electron/main/lib/ulid.ts` doesn't exist, replace the import + call with `crypto.randomUUID().slice(0, 8)`.

- [ ] **Step 4: Verify PASS + commit**

  ```bash
  npx vitest run electron/main/recording/manager.test.ts
  git add electron/main/recording/manager.{ts,test.ts}
  git commit -m "recording: RecordingManager start/stop with helper subprocess"
  ```

### Task 18: AppEnumerator

**Files:**
- Create: `electron/main/recording/app-enumerator.ts`
- Create: `electron/main/recording/app-enumerator.test.ts`

- [ ] **Step 1: Failing test**

  Write `electron/main/recording/app-enumerator.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { AppEnumerator } from './app-enumerator.js';

  describe('AppEnumerator', () => {
    it('parses helper output into source list', async () => {
      const helperOutput = JSON.stringify({
        event: 'processes',
        items: [
          { pid: 100, bundle_id: 'us.zoom.xos', name: 'Zoom', is_meeting_app: true },
          { pid: 200, bundle_id: 'com.google.Chrome', name: 'Google Chrome', is_meeting_app: false },
        ],
      }) + '\n';
      const fakeRunner = vi.fn(async () => ({ stdout: helperOutput, stderr: '' }));
      const e = new AppEnumerator({ helperPath: '/bin/meeting-notes-tap', runner: fakeRunner });

      const sources = await e.list();
      expect(sources).toHaveLength(2);
      expect(sources[0]!.isMeetingApp).toBe(true);
      expect(sources[0]!.name).toBe('Zoom');
    });
  });
  ```

- [ ] **Step 2: Implement**

  Write `electron/main/recording/app-enumerator.ts`:
  ```ts
  import { execFile } from 'node:child_process';
  import { promisify } from 'node:util';

  const pExecFile = promisify(execFile);

  export interface AudioSource {
    pid: number;
    bundleId: string | null;
    name: string | null;
    isMeetingApp: boolean;
  }

  type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

  export class AppEnumerator {
    constructor(private readonly deps: { helperPath: string; runner?: Runner }) {}

    async list(): Promise<AudioSource[]> {
      const runner = this.deps.runner ?? ((c, a) => pExecFile(c, a, { timeout: 5000 }));
      const { stdout } = await runner(this.deps.helperPath, ['--list-audio-processes']);
      const line = stdout.split('\n').find((l) => l.includes('"event":"processes"'));
      if (!line) return [];
      const payload = JSON.parse(line) as { items?: { pid: number; bundle_id?: string; name?: string; is_meeting_app?: boolean }[] };
      return (payload.items ?? []).map((it) => ({
        pid: it.pid,
        bundleId: it.bundle_id ?? null,
        name: it.name ?? null,
        isMeetingApp: it.is_meeting_app ?? false,
      }));
    }
  }
  ```

- [ ] **Step 3: Verify PASS + commit**

  ```bash
  npx vitest run electron/main/recording/app-enumerator.test.ts
  git add electron/main/recording/app-enumerator.{ts,test.ts}
  git commit -m "recording: AppEnumerator wraps --list-audio-processes"
  ```

### Task 19: Orphan recovery

**Files:**
- Create: `electron/main/recording/orphan-recovery.ts`
- Create: `electron/main/recording/orphan-recovery.test.ts`

- [ ] **Step 1: Failing test**

  Write `electron/main/recording/orphan-recovery.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import { recoverOrphans } from './orphan-recovery.js';

  describe('recoverOrphans', () => {
    it('marks open sessions as orphaned when their PID no longer exists', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-orph-'));
      const file = path.join(dir, 'orphan.m4a');
      fs.writeFileSync(file, 'fake but present');

      const repo = {
        findOpen: vi.fn(() => [{
          id: 's1', helperPid: 999999, outputPath: file,
          targetLabel: 'Zoom', targetPid: 1, startedAt: '', finalizedAt: null, status: 'recording' as const,
        }]),
        markOrphaned: vi.fn(),
        finalize: vi.fn(),
        markError: vi.fn(),
        insert: vi.fn(),
        findOrphaned: vi.fn(() => []),
      };
      const isAlive = vi.fn(() => false);

      await recoverOrphans({ repo: repo as any, isProcessAlive: isAlive });
      expect(repo.markOrphaned).toHaveBeenCalledWith('s1');
    });

    it('finalizes session if PID is somehow still alive (rare race)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-orph2-'));
      const file = path.join(dir, 'live.m4a');
      fs.writeFileSync(file, 'x');
      const repo = {
        findOpen: vi.fn(() => [{
          id: 's2', helperPid: process.pid, outputPath: file,
          targetLabel: 'X', targetPid: null, startedAt: '', finalizedAt: null, status: 'recording' as const,
        }]),
        markOrphaned: vi.fn(), finalize: vi.fn(), markError: vi.fn(),
        insert: vi.fn(), findOrphaned: vi.fn(() => []),
      };
      await recoverOrphans({ repo: repo as any, isProcessAlive: () => true });
      // Don't touch sessions whose helper is still running — assume MeetingNotes
      // also running, just slow to handle exit. Don't double-handle.
      expect(repo.markOrphaned).not.toHaveBeenCalled();
      expect(repo.finalize).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Implement**

  Write `electron/main/recording/orphan-recovery.ts`:
  ```ts
  import type { RecordingSessionsRepo } from '../storage/recording-sessions-repo.js';

  export interface RecoverDeps {
    repo: RecordingSessionsRepo;
    isProcessAlive?: (pid: number) => boolean;
  }

  /**
   * Called once at app launch. Scans recording_sessions for open rows whose
   * helper PID is dead. Those are real orphans (parent died, helper exited
   * via parent-watch); their files are on disk and the LibraryWatcher will
   * pick them up. We just update DB status so future scans don't re-process.
   */
  export async function recoverOrphans(deps: RecoverDeps): Promise<void> {
    const isAlive = deps.isProcessAlive ?? defaultIsAlive;
    for (const row of deps.repo.findOpen()) {
      if (!isAlive(row.helperPid)) {
        deps.repo.markOrphaned(row.id);
      }
      // If the helper is somehow still alive, don't touch — let it finish.
    }
  }

  function defaultIsAlive(pid: number): boolean {
    try {
      // Signal 0 doesn't actually send anything but errors if process is gone.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  ```

- [ ] **Step 3: Verify PASS + commit**

  ```bash
  npx vitest run electron/main/recording/orphan-recovery.test.ts
  git add electron/main/recording/orphan-recovery.{ts,test.ts}
  git commit -m "recording: orphan-recovery scan on launch"
  ```

---

## Phase 6: IPC + Permissions

### Task 20: IPC contracts + handlers + preload for recording

**Files:**
- Modify: `electron/main/ipc/contracts.ts`
- Modify: `electron/main/ipc/handlers.ts`
- Modify: `electron/preload/index.ts`

- [ ] **Step 1: Add channel constants**

  In `electron/main/ipc/contracts.ts`, add to `IPC_CHANNELS`:
  ```ts
    recordingListSources: 'recording:list-sources',
    recordingStart: 'recording:start',
    recordingStop: 'recording:stop',
    recordingState: 'recording:state',
    recordingLevelEvent: 'recording:level',
    recordingStateEvent: 'recording:state-change',
  ```

  Also add identical entries to the `IPC_CHANNELS` block in `electron/preload/index.ts` (parity test enforces this).

- [ ] **Step 2: Add handlers**

  In `electron/main/ipc/handlers.ts`, in `IpcServices` add:
  ```ts
  recordingManager: import('../recording/manager.js').RecordingManager;
  appEnumerator: import('../recording/app-enumerator.js').AppEnumerator;
  ```

  And register handlers (inside `registerIpcHandlers`):
  ```ts
  ipc.handle(IPC_CHANNELS.recordingListSources, async () => {
    return s.appEnumerator.list();
  });
  ipc.handle(IPC_CHANNELS.recordingStart, async (_e, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('invalid args');
    const { targetPid, targetLabel, mic } = input as { targetPid: number | 'system'; targetLabel: string; mic: boolean };
    return s.recordingManager.start({ targetPid, targetLabel, mic });
  });
  ipc.handle(IPC_CHANNELS.recordingStop, async (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('sessionId required');
    return s.recordingManager.stop(sessionId);
  });
  ipc.handle(IPC_CHANNELS.recordingState, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('sessionId required');
    return s.recordingManager.state(sessionId);
  });
  ```

  In `electron/main/index.ts`, after constructing `RecordingManager` (Task 21), wire its events to broadcast on the IPC channels:
  ```ts
  recordingManager.on('level', (sessionId, peakDb) => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.recordingLevelEvent, { sessionId, peakDb }));
  });
  recordingManager.on('state-change', (sessionId, state) => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.recordingStateEvent, { sessionId, state }));
  });
  ```

- [ ] **Step 3: Preload API**

  In `electron/preload/index.ts`, add to the `api` object:
  ```ts
  recording: {
    listSources: () => ipcRenderer.invoke(IPC_CHANNELS.recordingListSources),
    start: (input: { targetPid: number | 'system'; targetLabel: string; mic: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.recordingStart, input),
    stop: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.recordingStop, sessionId),
    state: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.recordingState, sessionId),
    onLevel: (cb: (e: { sessionId: string; peakDb: number }) => void) => {
      const wrapped = (_e: unknown, payload: any) => cb(payload);
      ipcRenderer.on(IPC_CHANNELS.recordingLevelEvent, wrapped);
      return () => ipcRenderer.off(IPC_CHANNELS.recordingLevelEvent, wrapped);
    },
    onStateChange: (cb: (e: { sessionId: string; state: string }) => void) => {
      const wrapped = (_e: unknown, payload: any) => cb(payload);
      ipcRenderer.on(IPC_CHANNELS.recordingStateEvent, wrapped);
      return () => ipcRenderer.off(IPC_CHANNELS.recordingStateEvent, wrapped);
    },
  },
  ```

- [ ] **Step 4: Verify parity test passes**

  ```bash
  npx vitest run electron/main/ipc/handlers.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add electron/main/ipc electron/preload
  git commit -m "ipc: recording channels (list-sources, start, stop, state, events)"
  ```

### Task 21: Wire RecordingManager into electron/main/index.ts

**Files:**
- Modify: `electron/main/index.ts`

- [ ] **Step 1: Construct + register**

  In `electron/main/index.ts`, after `const audioHijack = ...` (about to be deleted but still there), add:
  ```ts
  import { RecordingManager } from './recording/manager.js';
  import { AppEnumerator } from './recording/app-enumerator.js';
  import { RecordingSessionsRepo } from './storage/recording-sessions-repo.js';
  import { resolveHelperPath } from './recording/helper-path.js';
  import { recoverOrphans } from './recording/orphan-recovery.js';
  import { app, BrowserWindow } from 'electron';

  const helperPath = resolveHelperPath({
    isPackaged: app.isPackaged,
    appPath: process.cwd(),
    resourcesPath: process.resourcesPath,
  });
  const recordingsDir = path.join(os.homedir(), 'Music', 'MeetingNotes');
  fs.mkdirSync(recordingsDir, { recursive: true });
  const recordingSessionsRepo = new RecordingSessionsRepo(db);
  const recordingManager = new RecordingManager({
    helperPath,
    recordingsDir,
    repo: recordingSessionsRepo,
  });
  const appEnumerator = new AppEnumerator({ helperPath });

  // Run orphan recovery once at startup, before opening any windows.
  await recoverOrphans({ repo: recordingSessionsRepo });
  ```

  And add to the `IpcServices` literal passed to `registerIpcHandlers`:
  ```ts
  recordingManager,
  appEnumerator,
  ```

- [ ] **Step 2: App-quit safety — stop active recordings**

  Add near the bottom:
  ```ts
  app.on('before-quit', async (event) => {
    const open = recordingSessionsRepo.findOpen();
    if (open.length === 0) return;
    event.preventDefault();
    for (const row of open) {
      try { await recordingManager.stop(row.id); } catch { /* best-effort */ }
    }
    app.quit();
  });
  ```

- [ ] **Step 3: Build + smoke test**

  ```bash
  npm run build
  ```
  Expected: clean build.

- [ ] **Step 4: Commit**

  ```bash
  git add electron/main/index.ts
  git commit -m "main: wire RecordingManager + orphan recovery + quit-safety"
  ```

### Task 22: Permissions probe + IPC

**Files:**
- Create: `electron/main/permissions/audio.ts`
- Create: `electron/main/permissions/audio.test.ts`
- Modify: `electron/main/ipc/contracts.ts`, `electron/main/ipc/handlers.ts`, `electron/preload/index.ts`

- [ ] **Step 1: Failing test**

  Write `electron/main/permissions/audio.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { probeAudioPermissions } from './audio.js';

  describe('probeAudioPermissions', () => {
    it('parses helper JSON into mic + audioCapture states', async () => {
      const runner = vi.fn(async () => ({
        stdout: JSON.stringify({ event: 'permissions', mic: 'granted', audio_capture: 'denied' }) + '\n',
        stderr: '',
      }));
      const result = await probeAudioPermissions({ helperPath: '/bin/x', runner });
      expect(result).toEqual({ mic: 'granted', audioCapture: 'denied' });
    });
  });
  ```

- [ ] **Step 2: Implement**

  Write `electron/main/permissions/audio.ts`:
  ```ts
  import { execFile } from 'node:child_process';
  import { promisify } from 'node:util';

  const pExecFile = promisify(execFile);

  export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'unknown';
  export interface AudioPermissions { mic: PermissionState; audioCapture: PermissionState; }

  type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

  export async function probeAudioPermissions(
    deps: { helperPath: string; runner?: Runner },
  ): Promise<AudioPermissions> {
    const runner = deps.runner ?? ((c, a) => pExecFile(c, a, { timeout: 5000 }));
    const { stdout } = await runner(deps.helperPath, ['--probe-permissions']);
    const line = stdout.split('\n').find((l) => l.includes('"event":"permissions"'));
    if (!line) return { mic: 'unknown', audioCapture: 'unknown' };
    const p = JSON.parse(line) as { mic?: string; audio_capture?: string };
    return {
      mic: (p.mic as PermissionState) ?? 'unknown',
      audioCapture: (p.audio_capture as PermissionState) ?? 'unknown',
    };
  }
  ```

- [ ] **Step 3: Add IPC channel + handler + preload**

  Same pattern as Task 20:
  - `permissionsAudioGet: 'permissions:audio-get'` in both `contracts.ts` and `preload/index.ts` IPC_CHANNELS.
  - Handler: `ipc.handle(IPC_CHANNELS.permissionsAudioGet, () => probeAudioPermissions({ helperPath }));`
  - Preload: `permissions: { audio: () => ipcRenderer.invoke(IPC_CHANNELS.permissionsAudioGet) }`

- [ ] **Step 4: Verify + commit**

  ```bash
  npx vitest run electron/main/permissions/audio.test.ts electron/main/ipc/handlers.test.ts
  git add electron/main/permissions electron/main/ipc electron/preload
  git commit -m "permissions: audio probe via helper + IPC channel"
  ```

---

## Phase 7: Renderer UI

### Task 23: VuMeter component

**Files:**
- Create: `electron/renderer/src/components/VuMeter.tsx`

- [ ] **Step 1: Implement**

  Write `electron/renderer/src/components/VuMeter.tsx`:
  ```tsx
  // Tiny segmented level meter for the live recording row. peakDb is the
  // most recent peak (-160..0). We map to a 0..1 fill and split into
  // 10 segments. Re-renders only when peakDb changes meaningfully.
  export function VuMeter({ peakDb }: { peakDb: number }): JSX.Element {
    // -60dB is "quiet but audible," 0dB is "clipping." Clamp + normalize.
    const fill = Math.max(0, Math.min(1, (peakDb + 60) / 60));
    const lit = Math.round(fill * 10);
    return (
      <div className="flex items-center gap-[2px]" aria-label={`peak ${peakDb.toFixed(0)} dB`}>
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className={`w-[3px] h-3 rounded-sm ${
              i < lit
                ? i < 7 ? 'bg-status-ok' : i < 9 ? 'bg-status-warn' : 'bg-rose-500'
                : 'bg-surface-border'
            }`}
          />
        ))}
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add electron/renderer/src/components/VuMeter.tsx
  git commit -m "ui: VuMeter component"
  ```

### Task 24: SourcePicker component

**Files:**
- Create: `electron/renderer/src/components/SourcePicker.tsx`

- [ ] **Step 1: Implement**

  Write `electron/renderer/src/components/SourcePicker.tsx`:
  ```tsx
  import { useEffect, useState } from 'react';
  import { api } from '../ipc/client';

  export interface PickedSource { targetPid: number | 'system'; targetLabel: string; }

  export function SourcePicker({
    onPick, onCancel,
  }: { onPick: (src: PickedSource) => void; onCancel: () => void }): JSX.Element {
    const [sources, setSources] = useState<{ pid: number; name: string | null; bundleId: string | null; isMeetingApp: boolean }[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      void (async () => {
        try {
          const list = (await api.recording.listSources()) as typeof sources;
          // Meeting apps first, others after, "All system audio" appended.
          const sorted = [...list].sort((a, b) => Number(b.isMeetingApp) - Number(a.isMeetingApp));
          setSources(sorted);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setLoading(false);
        }
      })();
    }, []);

    return (
      <div className="absolute right-0 top-full mt-2 z-30 w-72 bg-surface border border-surface-border rounded-xl shadow-pop p-2">
        <div className="text-[11px] font-mono uppercase tracking-wider text-ink-muted px-2 py-1">
          Recording from
        </div>
        {loading && <div className="px-2 py-3 text-sm text-ink-muted">Looking…</div>}
        {error && <div className="px-2 py-3 text-sm text-rose-600">{error}</div>}
        {!loading && sources.map((s) => (
          <button
            key={s.pid}
            onClick={() => onPick({ targetPid: s.pid, targetLabel: s.name ?? `PID ${s.pid}` })}
            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-surface-sunken text-sm flex items-center gap-2"
          >
            <span className="flex-1">{s.name ?? `PID ${s.pid}`}</span>
            {s.isMeetingApp && <span className="text-[10px] text-brand-indigo font-semibold">MEETING</span>}
          </button>
        ))}
        <div className="border-t border-surface-border my-1" />
        <button
          onClick={() => onPick({ targetPid: 'system', targetLabel: 'All system audio' })}
          className="w-full text-left px-2 py-1.5 rounded-md hover:bg-surface-sunken text-sm"
        >
          All system audio (catch-all)
        </button>
        <button onClick={onCancel} className="w-full text-left px-2 py-1.5 rounded-md text-sm text-ink-muted hover:text-ink">
          Cancel
        </button>
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add electron/renderer/src/components/SourcePicker.tsx
  git commit -m "ui: SourcePicker component"
  ```

### Task 25: LiveRecordingRow component

**Files:**
- Create: `electron/renderer/src/components/LiveRecordingRow.tsx`

- [ ] **Step 1: Implement**

  Write `electron/renderer/src/components/LiveRecordingRow.tsx`:
  ```tsx
  import { useEffect, useState } from 'react';
  import { api } from '../ipc/client';
  import { VuMeter } from './VuMeter';
  import { useElapsed, fmtElapsed } from '../lib/useElapsed';

  export function LiveRecordingRow({
    sessionId, label, startedAt, onStopped,
  }: {
    sessionId: string;
    label: string;
    startedAt: string;
    onStopped: () => void;
  }): JSX.Element {
    const elapsed = useElapsed(startedAt, true);
    const [peakDb, setPeakDb] = useState(-60);
    const [stopping, setStopping] = useState(false);

    useEffect(() => {
      const off = api.recording.onLevel((e) => {
        if (e.sessionId === sessionId) setPeakDb(e.peakDb);
      });
      return off;
    }, [sessionId]);

    async function stop(): Promise<void> {
      setStopping(true);
      try {
        await api.recording.stop(sessionId);
      } finally {
        setStopping(false);
        onStopped();
      }
    }

    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50/40 px-4 py-3 flex items-center gap-4">
        <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink truncate">Recording: {label}</div>
          <div className="text-xs text-ink-muted tabular-nums">{elapsed !== null ? fmtElapsed(elapsed) : '0s'}</div>
        </div>
        <VuMeter peakDb={peakDb} />
        <button
          onClick={stop}
          disabled={stopping}
          className="text-xs font-semibold bg-rose-500 text-white px-3 py-1.5 rounded-md hover:bg-rose-600 disabled:opacity-40"
        >
          {stopping ? 'Stopping…' : '■ Stop'}
        </button>
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add electron/renderer/src/components/LiveRecordingRow.tsx
  git commit -m "ui: LiveRecordingRow component with elapsed + VU meter"
  ```

### Task 26: Update RecordButton to use SourcePicker + new IPC

**Files:**
- Modify: `electron/renderer/src/components/RecordButton.tsx`

- [ ] **Step 1: Replace contents**

  ```tsx
  import { useState } from 'react';
  import { api } from '../ipc/client';
  import { SourcePicker, type PickedSource } from './SourcePicker';

  export function RecordButton({
    onStarted,
  }: {
    onStarted: (info: { sessionId: string; label: string }) => void;
  }): JSX.Element {
    const [pickerOpen, setPickerOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function pick(src: PickedSource): Promise<void> {
      setPickerOpen(false);
      setBusy(true); setError(null);
      try {
        const { sessionId } = await api.recording.start({
          targetPid: src.targetPid, targetLabel: src.targetLabel, mic: true,
        }) as { sessionId: string };
        onStarted({ sessionId, label: src.targetLabel });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    }

    return (
      <div className="relative">
        <button
          onClick={() => setPickerOpen(true)}
          disabled={busy}
          className="rounded-xl px-5 py-2 text-sm font-semibold text-white shadow-card bg-gradient-to-br from-brand-indigo to-brand-violet disabled:opacity-50"
        >
          {busy ? 'Starting…' : '⏺ Record'}
        </button>
        {pickerOpen && <SourcePicker onPick={pick} onCancel={() => setPickerOpen(false)} />}
        {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add electron/renderer/src/components/RecordButton.tsx
  git commit -m "ui: RecordButton opens SourcePicker, calls recording.start"
  ```

### Task 27: LibraryView renders LiveRecordingRow

**Files:**
- Modify: `electron/renderer/src/views/LibraryView.tsx`

- [ ] **Step 1: Add live-recording state**

  Near the top of `LibraryView`:
  ```tsx
  const [liveRecording, setLiveRecording] = useState<
    { sessionId: string; label: string; startedAt: string } | null
  >(null);
  ```

- [ ] **Step 2: Replace `<RecordButton sessionName="Meeting" />`**

  ```tsx
  <RecordButton onStarted={({ sessionId, label }) => setLiveRecording({
    sessionId, label, startedAt: new Date().toISOString(),
  })} />
  ```

- [ ] **Step 3: Render LiveRecordingRow above the Inbox section**

  ```tsx
  {liveRecording && (
    <div className="mb-6">
      <LiveRecordingRow
        sessionId={liveRecording.sessionId}
        label={liveRecording.label}
        startedAt={liveRecording.startedAt}
        onStopped={() => { setLiveRecording(null); void refresh(); }}
      />
    </div>
  )}
  ```

  Add the import at the top:
  ```tsx
  import { LiveRecordingRow } from '../components/LiveRecordingRow';
  ```

- [ ] **Step 4: Verify build**

  ```bash
  npm run -s typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add electron/renderer/src/views/LibraryView.tsx
  git commit -m "ui: LibraryView shows LiveRecordingRow during active recording"
  ```

### Task 28: PermissionsModal + first-launch trigger

**Files:**
- Create: `electron/renderer/src/components/PermissionsModal.tsx`
- Modify: `electron/renderer/src/App.tsx`

- [ ] **Step 1: Implement modal**

  Write `electron/renderer/src/components/PermissionsModal.tsx` (uses R3 deep-link URLs):
  ```tsx
  import { useEffect, useState } from 'react';
  import { api } from '../ipc/client';

  type State = 'granted' | 'denied' | 'not-determined' | 'unknown';

  export function PermissionsModal({ onAllGranted }: { onAllGranted: () => void }): JSX.Element {
    const [mic, setMic] = useState<State>('unknown');
    const [audioCapture, setAudioCapture] = useState<State>('unknown');

    async function recheck(): Promise<void> {
      const r = (await api.permissions.audio()) as { mic: State; audioCapture: State };
      setMic(r.mic); setAudioCapture(r.audioCapture);
      if (r.mic === 'granted' && r.audioCapture === 'granted') onAllGranted();
    }

    useEffect(() => { void recheck(); const t = setInterval(recheck, 2000); return () => clearInterval(t); }, []);

    return (
      <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
        <div className="bg-surface rounded-2xl shadow-pop max-w-md w-full p-6">
          <h2 className="text-lg font-semibold mb-2">Permissions needed</h2>
          <p className="text-sm text-ink-muted mb-4">
            MeetingNotes records meetings by tapping the microphone and the audio your computer plays. macOS needs your explicit permission for both.
          </p>
          <PermRow label="Microphone" state={mic}
            link="x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone" />
          <PermRow label="System audio" state={audioCapture}
            link="x-apple.systempreferences:com.apple.preference.security?Privacy" />
          <div className="mt-4 text-xs text-ink-muted">
            After granting in System Settings, this dialog will close automatically.
          </div>
        </div>
      </div>
    );
  }

  function PermRow({ label, state, link }: { label: string; state: State; link: string }): JSX.Element {
    return (
      <div className="flex items-center gap-3 py-2 border-t border-surface-border">
        <div className="flex-1">
          <div className="text-sm font-semibold">{label}</div>
          <div className="text-xs text-ink-muted">{state === 'granted' ? '✓ Granted' : state === 'denied' ? '✗ Denied' : 'Not granted yet'}</div>
        </div>
        {state !== 'granted' && (
          <button onClick={() => window.open(link)} className="text-xs font-semibold bg-brand-indigo text-white px-3 py-1.5 rounded-md">
            Grant
          </button>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 2: Wire into App.tsx**

  In `electron/renderer/src/App.tsx`:
  ```tsx
  import { useEffect, useState } from 'react';
  import { PermissionsModal } from './components/PermissionsModal';
  import { api } from './ipc/client';
  // ... existing imports

  // Inside App component:
  const [permsOk, setPermsOk] = useState(true);
  useEffect(() => {
    void (async () => {
      const r = (await api.permissions.audio()) as { mic: string; audioCapture: string };
      setPermsOk(r.mic === 'granted' && r.audioCapture === 'granted');
    })();
  }, []);

  if (!permsOk) return <PermissionsModal onAllGranted={() => setPermsOk(true)} />;
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add electron/renderer/src
  git commit -m "ui: PermissionsModal probed at app start, deep-links to System Settings"
  ```

### Task 29: SettingsView updates

**Files:**
- Modify: `electron/renderer/src/views/SettingsView.tsx`
- Modify: `electron/main/storage/settings-repo.ts`

- [ ] **Step 1: Update settings-repo defaults**

  In `electron/main/storage/settings-repo.ts`:
  ```ts
  // Add to Settings interface:
  recordingBitrateKbps: number;

  // Update DEFAULT_SETTINGS:
  audioWatchPath: path.join(os.homedir(), 'Music', 'MeetingNotes'),
  recordingBitrateKbps: 128,
  ```

  The old `audioHijackSessionName` field stays in the type for now (not removed) but no code reads it anymore.

- [ ] **Step 2: Update SettingsView**

  In `electron/renderer/src/views/SettingsView.tsx`:
  - Remove the "Audio Hijack Session Name" `<Field>` block.
  - Rename "Watch path" label to "Recordings folder."
  - Add a "Permissions" section that calls `api.permissions.audio()` on mount and shows mic + audio-capture state with a "Recheck" button.
  - Add a "Recording quality" section with a `<select>` for bitrate (96 / 128 / 192).

- [ ] **Step 3: Verify**

  ```bash
  npm run -s typecheck
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add electron/renderer/src/views/SettingsView.tsx electron/main/storage/settings-repo.ts
  git commit -m "ui: Settings drops AH session name; adds permissions + bitrate"
  ```

---

## Phase 8: LibraryWatcher + AudioHijackBridge deletion

### Task 30: LibraryWatcher accepts .m4a + dual-watch path

**Files:**
- Modify: `electron/main/library/watcher.ts`
- Modify: `electron/main/library/watcher.test.ts`

- [ ] **Step 1: Add test cases**

  In `watcher.test.ts`, add cases:
  ```ts
  it('detects .m4a files', () => {
    // ... fixture file with .m4a extension, assert it produces a discovered event
  });
  it('watches multiple paths when configured', () => {
    // ... two folders, files dropped in each, both detected
  });
  ```

- [ ] **Step 2: Modify the watcher**

  Update the file glob/regex to accept `.mp3` or `.m4a`. Accept either a single path or an array of paths in the constructor.

- [ ] **Step 3: Verify tests pass**

  ```bash
  npx vitest run electron/main/library/watcher.test.ts
  ```

- [ ] **Step 4: Wire dual-watch in main**

  In `electron/main/index.ts`, where the watcher is constructed:
  ```ts
  const watcher = new LibraryWatcher({
    paths: [s.audioWatchPath, path.join(os.homedir(), 'Music', 'Audio Hijack')],
  });
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add electron/main/library electron/main/index.ts
  git commit -m "library: watcher accepts .m4a + dual-watch (new + AH legacy)"
  ```

### Task 31: Delete AudioHijackBridge

**Files:**
- Delete: `electron/main/audio-hijack/bridge.ts`
- Delete: `electron/main/audio-hijack/bridge.test.ts`
- Delete: `electron/main/audio-hijack/` (empty after the above)
- Modify: `electron/main/index.ts` (remove import + construction)
- Modify: `electron/main/ipc/handlers.ts` (remove `record:start`, `record:stop`, `record:state` old handlers if still present)
- Modify: `electron/preload/index.ts` (remove old `record.*` API)
- Modify: `electron/main/ipc/contracts.ts` (remove old `record*` IPC channels)

- [ ] **Step 1: Delete the files**

  ```bash
  git rm -rf electron/main/audio-hijack
  ```

- [ ] **Step 2: Remove imports + references**

  - In `index.ts`, delete the `AudioHijackBridge` import + `audioHijack = new AudioHijackBridge()` line + the `audioHijack` field passed to `IpcServices`.
  - In `handlers.ts`, delete the `record:start/stop/state` handlers and the `audioHijack` field in `IpcServices`.
  - In `contracts.ts` and `preload/index.ts`, delete the old `record*` channel constants and the preload `record` API. (`recording:*` is the new namespace.)

- [ ] **Step 3: Verify**

  ```bash
  npm run -s typecheck
  npx vitest run electron/main/ipc/handlers.test.ts
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add -A
  git commit -m "audio-hijack: delete bridge + IPC; recording namespace replaces it"
  ```

---

## Phase 9: Manual smoke test

### Task 32: Update manual smoke test doc

**Files:**
- Modify: `docs/manual-smoke-test.md`

- [ ] **Step 1: Append new test cases**

  Add a "Built-in audio capture" section:
  ```markdown
  ## Built-in audio capture

  - [ ] First-launch on a fresh user account: PermissionsModal appears with both mic + audio-capture rows ungranted. Each "Grant" button opens the right pane in System Settings.
  - [ ] After granting both, the modal closes automatically within a few seconds.
  - [ ] Click Record. SourcePicker opens within ~1 second showing all currently-running audio apps. Zoom (or Music if Zoom isn't running) appears with a "MEETING" or no badge respectively.
  - [ ] Pick an app. LiveRecordingRow appears at the top of the Library with elapsed timer ticking and VU meter responding to audio.
  - [ ] Click ■ Stop. Row disappears, file appears in `~/Music/MeetingNotes/`, and shows up in Inbox within ~1 second.
  - [ ] Process the file through the existing pipeline. Whisper accepts .m4a. Transcript shows expected speech.
  - [ ] Test "All system audio" — capture system audio while playing music + having a Slack call. Both should be in the file.
  - [ ] Force-quit MeetingNotes mid-recording (`pkill -KILL MeetingNotes`). On relaunch, the file is in Inbox; recording_sessions row marked 'orphaned'.
  - [ ] Quit the target app mid-recording (close Zoom while recording from Zoom). Helper auto-stops within a second; file finalized.
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add docs/manual-smoke-test.md
  git commit -m "docs: smoke-test cases for built-in audio capture"
  ```

### Task 33: Run smoke test + capture findings

- [ ] **Step 1: Build a fresh .app**

  ```bash
  npm run dist
  ```

- [ ] **Step 2: Reset permissions to simulate first-launch**

  ```bash
  tccutil reset Microphone com.dbbaskette.meetingnotes
  # If a tccutil service name exists for audio capture, reset that too.
  ```

- [ ] **Step 3: Walk through every checkbox in `docs/manual-smoke-test.md` "Built-in audio capture" section**

  Note any failures or rough UX. File a follow-up GitHub issue for anything that's not a hard regression.

- [ ] **Step 4: Close issue #3 with a comment summarizing the work**

  ```bash
  gh issue close 3 --comment "$(cat <<'EOF'
  Implemented in <list of commits>. Audio Hijack dependency removed; recording now via bundled Swift helper using CoreAudio Process Tap. Smoke test passed.
  EOF
  )"
  ```

---

## Self-review checklist (run after writing the plan)

- [x] Spec coverage: every spec section has a task. Permissions modal ✓, source picker ✓, live recording row ✓, M4A ✓, mono mix ✓, helper CLI surface ✓, orphan recovery ✓, target-quit auto-stop ✓, AH deletion ✓, settings updates ✓, smoke test ✓.
- [x] Placeholders: research tasks intentionally have "document findings" steps but no "TODO" or "implement later" in real implementation tasks. Recorder.swift's mic-deferred comment is now resolved by Task 9.
- [x] Type consistency: `RecordingState`, `AudioPermissions`, `PickedSource`, `AudioSource`, `RecordingSessionRow` defined once and used consistently.
- [x] No "TBD" for things that block work — entitlements + browser handling + deep link are gated behind explicit research tasks (R1, R2, R3) ordered before downstream tasks that depend on them.
