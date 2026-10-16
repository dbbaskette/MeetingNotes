// swift-tools-version: 6.2
import PackageDescription
let package = Package(name: "ParakeetComparison", platforms: [.macOS(.v15)],
    dependencies: [.package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7", traits: [])],
    targets: [.executableTarget(name: "parakeet-comparison", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")], path: "Sources")])
