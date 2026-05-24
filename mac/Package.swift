// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ConduitMacApp",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ConduitMacApp",
            path: "Sources/ConduitMacApp"
        )
    ]
)
