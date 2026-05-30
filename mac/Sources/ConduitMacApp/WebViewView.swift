import SwiftUI
import WebKit

struct WebViewView: NSViewRepresentable {
    @ObservedObject var tab: TabItem

    func makeCoordinator() -> Coordinator { Coordinator(tab: tab) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()  // shared cookies across tabs
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        if #available(macOS 14.0, *) {
            // Make sure WebRTC / getUserMedia is enabled in WKWebView.
            config.preferences.setValue(true, forKey: "mediaDevicesEnabled")
            config.preferences.setValue(true, forKey: "peerConnectionEnabled")
            config.preferences.setValue(true, forKey: "mediaCaptureRequiresSecureConnection")
        }
        let pagePrefs = WKWebpagePreferences()
        pagePrefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = pagePrefs

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.allowsBackForwardNavigationGestures = true
        wv.navigationDelegate = context.coordinator
        wv.uiDelegate = context.coordinator
        // Match a current Safari UA so the PWA serves modern bundles.
        wv.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 ConduitMac/1.0"

        context.coordinator.attach(wv)
        wv.load(URLRequest(url: tab.url))
        return wv
    }

    func updateNSView(_ wv: WKWebView, context: Context) {
        // nothing - tab is identity-stable, coordinator owns observers
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let tab: TabItem
        weak var webView: WKWebView?
        private var titleObs: NSKeyValueObservation?
        private var loadingObs: NSKeyValueObservation?
        private var urlObs: NSKeyValueObservation?
        private var reloadToken: NSObjectProtocol?

        init(tab: TabItem) {
            self.tab = tab
            super.init()
            reloadToken = NotificationCenter.default.addObserver(
                forName: .conduitReloadTab, object: nil, queue: .main
            ) { [weak self] note in
                guard let self else { return }
                if (note.object as? UUID) == self.tab.id {
                    self.webView?.reload()
                }
            }
        }

        deinit {
            if let t = reloadToken { NotificationCenter.default.removeObserver(t) }
        }

        @MainActor
        func attach(_ wv: WKWebView) {
            self.webView = wv
            titleObs = wv.observe(\.title, options: [.new]) { [weak self] _, change in
                guard let self else { return }
                let new = change.newValue ?? nil
                Task { @MainActor in
                    if let t = new, !t.isEmpty {
                        self.tab.title = t
                    }
                }
            }
            loadingObs = wv.observe(\.isLoading, options: [.new]) { [weak self] _, change in
                guard let self else { return }
                let v = change.newValue ?? false
                Task { @MainActor in
                    self.tab.isLoading = v
                }
            }
            urlObs = wv.observe(\.url, options: [.new]) { [weak self] _, change in
                guard let self, let new = change.newValue ?? nil else { return }
                Task { @MainActor in
                    self.tab.url = new
                }
            }
        }

        // MARK: - Mic / Camera prompts
        func webView(_ webView: WKWebView,
                     requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            // Only grant mic/camera to our own PWA origin. A redirected or
            // compromised page on any other host gets denied.
            if AppConfig.isTrustedHost(origin.host) {
                decisionHandler(.grant)
            } else {
                decisionHandler(.deny)
            }
        }

        // MARK: - target=_blank → open externally in the system browser
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            // Only hand http(s) URLs to the system browser; never arbitrary
            // schemes (file:, custom app schemes) a malicious page could inject.
            if let url = navigationAction.request.url,
               let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https" {
                NSWorkspace.shared.open(url)
            }
            return nil
        }
    }
}
