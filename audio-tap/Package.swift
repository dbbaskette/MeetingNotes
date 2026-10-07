// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "meeting-notes-tap",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "meeting-notes-tap"),
    .testTarget(name: "meeting-notes-tap-tests", dependencies: ["meeting-notes-tap"]),
  ]
)
