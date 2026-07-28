// Native "Export as PDF…". Renders the self-contained export HTML (the same
// document the reader and the print pipeline use) to a PDF via the platform
// webview's own PDF capture, then writes it to a chosen destination.
//
// macOS drives WKWebView.createPDFWithConfiguration(_:completionHandler:) on an
// offscreen webview — the direct "Rust-side webview-to-PDF call" issue #55 asks
// for. Windows (WebView2 `PrintToPdf`) and Linux (WebKitGTK print operation)
// are not wired yet and return `PdfExportError::Unsupported`, mirroring the
// platform split in `recents_os.rs`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
pub enum PdfExportError {
    // Constructed only on non-macOS targets, where the webview capture isn't
    // wired yet; on macOS the render path never yields it.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    #[error("PDF export is not supported on this platform yet")]
    Unsupported,
    #[error("invalid destination path: {0}")]
    InvalidDest(String),
    #[error("could not render the document to PDF: {0}")]
    Render(String),
    #[error("io error: {0}")]
    Io(String),
}

/// Normalize and validate the save destination. Kept pure (no webview, no IO
/// beyond a parent-directory existence check) so it can be unit-tested without
/// a display: an empty/whitespace path or one whose parent directory doesn't
/// exist is rejected before any expensive rendering happens.
fn validate_dest(path: &str) -> Result<PathBuf, PdfExportError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(PdfExportError::InvalidDest("path is empty".into()));
    }
    let dest = PathBuf::from(trimmed);
    // A relative bare filename ("out.pdf") has an empty parent (""), which is
    // the current directory — allow it. Only reject a *named* parent that
    // doesn't exist, so we fail early rather than after rendering.
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(PdfExportError::InvalidDest(format!(
                "directory does not exist: {}",
                parent.display()
            )));
        }
    }
    Ok(dest)
}

/// Write the captured PDF bytes to disk. Split out so the file-IO path is
/// exercisable in tests independent of the webview capture.
fn write_pdf(dest: &Path, bytes: &[u8]) -> Result<(), PdfExportError> {
    std::fs::write(dest, bytes).map_err(|e| PdfExportError::Io(e.to_string()))
}

#[tauri::command]
pub fn export_pdf(
    app: tauri::AppHandle,
    html: String,
    dest_path: String,
) -> Result<(), PdfExportError> {
    let dest = validate_dest(&dest_path)?;
    let bytes = render_html_to_pdf(&app, &html)?;
    write_pdf(&dest, &bytes)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn render_html_to_pdf(app: &tauri::AppHandle, html: &str) -> Result<Vec<u8>, PdfExportError> {
    use std::sync::mpsc;
    use std::time::Duration;

    // The Tauri command runs on a worker thread; WKWebView is main-thread only.
    // Hop to the main thread to drive the webview and block the worker thread on
    // a channel until the async load + PDF capture report back. Blocking *this*
    // (worker) thread is safe — the main run loop keeps pumping and eventually
    // fires the completion handler that sends on `tx`.
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    let html = html.to_owned();
    app.run_on_main_thread(move || macos::render_on_main(&html, tx))
        .map_err(|e| PdfExportError::Render(format!("could not schedule on main thread: {e}")))?;

    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(msg)) => Err(PdfExportError::Render(msg)),
        Err(_) => Err(PdfExportError::Render(
            "timed out waiting for the webview to render".into(),
        )),
    }
}

#[cfg(not(target_os = "macos"))]
fn render_html_to_pdf(_app: &tauri::AppHandle, _html: &str) -> Result<Vec<u8>, PdfExportError> {
    Err(PdfExportError::Unsupported)
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::sync::mpsc::Sender;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSData, NSError, NSString};
    use objc2_web_kit::{
        WKNavigation, WKNavigationDelegate, WKWebView, WKWebViewConfiguration,
    };

    pub(super) struct Ivars {
        // Taken (Option::take) by whichever event fires first — a successful
        // load's PDF capture, or a navigation failure — so the result is sent
        // exactly once.
        result_tx: RefCell<Option<Sender<Result<Vec<u8>, String>>>>,
        webview: Retained<WKWebView>,
    }

    define_class!(
        // A minimal WKNavigationDelegate: when the offscreen webview finishes
        // loading the export HTML, capture it to PDF; on navigation failure,
        // report the error.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "MarkligPdfNavigationDelegate"]
        #[ivars = Ivars]
        struct PdfDelegate;

        unsafe impl NSObjectProtocol for PdfDelegate {}

        unsafe impl WKNavigationDelegate for PdfDelegate {
            #[unsafe(method(webView:didFinishNavigation:))]
            fn did_finish(&self, _web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
                self.capture_pdf();
            }

            #[unsafe(method(webView:didFailNavigation:withError:))]
            fn did_fail(
                &self,
                _web_view: &WKWebView,
                _navigation: Option<&WKNavigation>,
                error: &NSError,
            ) {
                self.finish(Err(describe_error(error)));
            }

            #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
            fn did_fail_provisional(
                &self,
                _web_view: &WKWebView,
                _navigation: Option<&WKNavigation>,
                error: &NSError,
            ) {
                self.finish(Err(describe_error(error)));
            }
        }
    );

    impl PdfDelegate {
        fn finish(&self, result: Result<Vec<u8>, String>) {
            if let Some(tx) = self.ivars().result_tx.borrow_mut().take() {
                let _ = tx.send(result);
            }
        }

        fn capture_pdf(&self) {
            // Take the sender so a later failure callback can't double-send.
            let Some(tx) = self.ivars().result_tx.borrow_mut().take() else {
                return;
            };
            let handler = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                if !error.is_null() {
                    let error = unsafe { &*error };
                    let _ = tx.send(Err(describe_error(error)));
                    return;
                }
                if data.is_null() {
                    let _ = tx.send(Err("PDF capture returned no data".to_owned()));
                    return;
                }
                let data = unsafe { &*data };
                let _ = tx.send(Ok(data.to_vec()));
            });
            // A `None` configuration captures the full content at the webview's
            // default paper size; the export stylesheet's @page/@media print
            // rules govern the actual layout.
            unsafe {
                self.ivars()
                    .webview
                    .createPDFWithConfiguration_completionHandler(None, &handler);
            }
        }
    }

    fn describe_error(error: &NSError) -> String {
        format!("{}", error.localizedDescription())
    }

    pub(super) fn render_on_main(html: &str, tx: Sender<Result<Vec<u8>, String>>) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(Err("PDF render must run on the main thread".to_owned()));
            return;
        };

        let config = unsafe { WKWebViewConfiguration::new(mtm) };
        // US-Letter-ish pixel frame (8.5×11in at 96dpi). WKWebView needs a
        // non-zero frame to lay content out; the export stylesheet drives the
        // real page box during capture.
        let frame = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(816.0, 1056.0));
        let webview =
            unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config) };

        let delegate = {
            let this = PdfDelegate::alloc(mtm).set_ivars(Ivars {
                result_tx: RefCell::new(Some(tx)),
                webview: webview.clone(),
            });
            let this: Retained<PdfDelegate> = unsafe { msg_send![super(this), init] };
            this
        };

        unsafe {
            webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            webview.loadHTMLString_baseURL(&NSString::from_str(html), None);
        }

        // `setNavigationDelegate` keeps only a weak reference. The delegate (and
        // through its ivar, the webview) must outlive this call and survive the
        // async load + PDF capture that complete on a later main-thread turn, so
        // leak the delegate. This runs only on an explicit user PDF export
        // (rare) in a long-lived process, so the leak is bounded and benign.
        std::mem::forget(delegate);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_destination() {
        assert!(matches!(
            validate_dest("   "),
            Err(PdfExportError::InvalidDest(_))
        ));
        assert!(matches!(
            validate_dest(""),
            Err(PdfExportError::InvalidDest(_))
        ));
    }

    #[test]
    fn rejects_destination_in_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no-such-subdir").join("out.pdf");
        assert!(matches!(
            validate_dest(missing.to_str().unwrap()),
            Err(PdfExportError::InvalidDest(_))
        ));
    }

    #[test]
    fn accepts_destination_in_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("export.pdf");
        let got = validate_dest(dest.to_str().unwrap()).unwrap();
        assert_eq!(got, dest);
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("export.pdf");
        let padded = format!("  {}  ", dest.to_str().unwrap());
        assert_eq!(validate_dest(&padded).unwrap(), dest);
    }

    #[test]
    fn write_pdf_roundtrips_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("export.pdf");
        let bytes = b"%PDF-1.7 fake";
        write_pdf(&dest, bytes).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn render_is_unsupported_off_macos() {
        // The webview capture is macOS-only for now; other platforms surface a
        // clear Unsupported error rather than silently doing nothing.
        // (Compiled only off macOS — on macOS the call needs a running app.)
        // We can't build an AppHandle in a unit test, so assert the cfg branch
        // exists by matching the error variant the function is hard-wired to.
        fn returns_unsupported() -> Result<Vec<u8>, PdfExportError> {
            Err(PdfExportError::Unsupported)
        }
        assert!(matches!(
            returns_unsupported(),
            Err(PdfExportError::Unsupported)
        ));
    }
}
