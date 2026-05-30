import Foundation

/// Central app configuration. Single source of truth for the PWA URL and the
/// host allowlist used to scope media-capture grants and external-link handling.
enum AppConfig {
    /// The PWA home URL new tabs open to.
    static let homeURL = URL(string: "https://conduit.rainerroloff.de")!

    /// Hosts the embedded WebView is trusted to be (our own PWA). Used to gate
    /// mic/camera permission grants. Anything else is denied.
    static let allowedHostSuffixes = ["rainerroloff.de"]

    /// Returns true if `host` belongs to one of the trusted suffixes.
    static func isTrustedHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased(), !host.isEmpty else { return false }
        return allowedHostSuffixes.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}
