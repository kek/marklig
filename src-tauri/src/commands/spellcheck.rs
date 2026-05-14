// Toggle continuous spell-checking on each window's native WebView.
//
// On macOS the WKWebView starts with continuous spell-checking OFF, so the
// `spellcheck="true"` HTML attribute that CodeMirror sets isn't enough on
// its own — without this, the user has to right-click the editor and tick
// "Check Spelling While Typing" before any underlines appear.
//
// `setContinuousSpellCheckingEnabled:` isn't part of WKWebView's public
// API. The contextual-menu item routes `toggleContinuousSpellChecking:`
// through the NSResponder chain, which only works when the WebView's
// internal text input is first responder — that's true after a click in
// the editor but not when the preferences window is focused. So we use
// the underscored private setter `_setContinuousSpellCheckingEnabled:`,
// which WKWebView exposes (declared in `WKWebViewPrivate.h`). It's gated
// on `respondsToSelector:` so a future WebKit / wry that drops the SPI
// degrades gracefully instead of crashing with NSInvalidArgumentException.
//
// Windows and Linux WebViews are no-ops; their spell-check is governed
// by the host platform.

use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
fn apply_to_webview(window: &tauri::WebviewWindow, enabled: bool) {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel};

    let _ = window.with_webview(move |wv| unsafe {
        let webview: *mut AnyObject = wv.inner().cast();

        let set_spell = sel!(_setContinuousSpellCheckingEnabled:);
        let responds_spell: Bool = msg_send![webview, respondsToSelector: set_spell];
        if responds_spell.as_bool() {
            let _: () = msg_send![webview, _setContinuousSpellCheckingEnabled: enabled];
        } else {
            eprintln!(
                "spellcheck: WKWebView doesn't respond to _setContinuousSpellCheckingEnabled:; skipping"
            );
        }

        let set_grammar = sel!(_setGrammarCheckingEnabled:);
        let responds_grammar: Bool = msg_send![webview, respondsToSelector: set_grammar];
        if responds_grammar.as_bool() {
            let _: () = msg_send![webview, _setGrammarCheckingEnabled: enabled];
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn apply_to_webview(_window: &tauri::WebviewWindow, _enabled: bool) {}

#[tauri::command]
pub fn set_continuous_spell_checking(app: AppHandle, enabled: bool) -> Result<(), String> {
    for (_, window) in app.webview_windows() {
        apply_to_webview(&window, enabled);
    }
    Ok(())
}
