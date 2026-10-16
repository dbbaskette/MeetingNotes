// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "MeetingNotesSpeech",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "meeting-notes-speech", targets: ["MeetingNotesSpeech"])],
    dependencies: [.package(url: "https://github.com/argmaxinc/argmax-oss-swift.git", exact: "1.1.1")],
    targets: [
        .executableTarget(name: "MeetingNotesSpeech", dependencies: [
            .product(name: "SpeakerKit", package: "argmax-oss-swift")
        ], path: "Sources"),
        .testTarget(name: "MeetingNotesSpeechTests", dependencies: ["MeetingNotesSpeech"], path: "Tests")
    ]
)
