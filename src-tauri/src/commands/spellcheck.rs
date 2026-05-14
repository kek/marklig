// Toggle continuous spell-checking on each window's native WebView.
//
// On macOS the WKWebView starts with continuous spell-checking OFF, so the
// `spellcheck="true"` HTML attribute that CodeMirror sets isn't enough on
// its own — without this, the user has to right-click the editor and tick
// "Check Spelling While Typing" before any underlines appear. That same
// menu item dispatches `toggleContinuousSpellChecking:`, an NSResponder
// action that WKWebView itself doesn't expose as a property but does
// forward through the responder chain. We drive the action ourselves via
// `tryToPerform:with:`, tracking the global enabled/disabled state so we
// only send the toggle when we actually need to flip.
//
// Windows and Linux WebViews are no-ops; their spell-check is governed
// by the host platform.

use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "macos")]
static MAC_SPELLCHECK_ENABLED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
fn toggle_on_webview(window: &tauri::WebviewWindow) {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel};

    let _ = window.with_webview(|wv| unsafe {
        let webview: *mut AnyObject = wv.inner().cast();
        // tryToPerform:with: walks the responder chain and returns whether
        // anything handled the action. We don't care about the return value;
        // if nothing responds, the toggle is silently dropped.
        let _: Bool = msg_send![
            webview,
            tryToPerform: sel!(toggleContinuousSpellChecking:),
            with: webview,
        ];
        let _: Bool = msg_send![
            webview,
            tryToPerform: sel!(toggleGrammarChecking:),
            with: webview,
        ];
    });
}

#[tauri::command]
pub fn set_continuous_spell_checking(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let previous = MAC_SPELLCHECK_ENABLED.swap(enabled, Ordering::SeqCst);
        if previous == enabled {
            return Ok(());
        }
        for (_, window) in app.webview_windows() {
            toggle_on_webview(&window);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
    }
    Ok(())
}
