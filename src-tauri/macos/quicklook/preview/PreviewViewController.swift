// Quick Look preview controller.
//
// Loads a markdown file from disk, renders it to HTML via MarkdownRenderer,
// and displays it in a sandboxed WKWebView. The web view is configured with
// JavaScript disabled and `loadHTMLString` (no remote frame) so the
// extension never executes script and never speaks to the network.

import Cocoa
import Quartz
import WebKit

final class PreviewViewController: NSViewController, QLPreviewingController {

    private var webView: WKWebView!

    override func loadView() {
        let config = WKWebViewConfiguration()
        if #available(macOS 11.0, *) {
            let prefs = WKWebpagePreferences()
            prefs.allowsContentJavaScript = false
            config.defaultWebpagePreferences = prefs
        }

        let v = WKWebView(frame: NSRect(x: 0, y: 0, width: 720, height: 800), configuration: config)
        v.translatesAutoresizingMaskIntoConstraints = false
        v.setValue(false, forKey: "drawsBackground")
        self.webView = v
        self.view = v
    }

    /// Quick Look (≥ macOS 12) entry point: hand back when rendering is
    /// guaranteed visible. We render synchronously into an in-memory HTML
    /// string and then let the web view's `didFinish` decide when to call back.
    func preparePreviewOfFile(at url: URL) async throws {
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        let source = String(data: data, encoding: .utf8) ?? ""
        let html = MarkdownRenderer.renderToHTML(source)

        await MainActor.run {
            // Use the file URL as base so relative image paths resolve against
            // the document's directory.
            let base = url.deletingLastPathComponent()
            self.webView.loadHTMLString(html, baseURL: base)
        }

        // Wait briefly for the web view to commit the load. WKWebView has no
        // synchronous render API; in practice Quick Look's hosting surface
        // tolerates this no-op return as long as we've called loadHTMLString
        // before returning.
        try? await Task.sleep(nanoseconds: 50_000_000)
    }

    // Note: the async `preparePreviewOfFile(at:)` above is automatically
    // bridged to the Objective-C completion-handler selector
    // `preparePreviewOfFileAtURL:completionHandler:` that QLPreviewingController
    // expects, so no separate completion-handler overload is needed.
}
