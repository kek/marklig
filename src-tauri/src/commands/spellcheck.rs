// Toggle continuous spell-checking on each window's native WebView.
//
// On macOS the WKWebView starts with continuous spell-checking OFF, so the
// `spellcheck="true"` HTML attribute that CodeMirror sets isn't enough on its
// own — the user would otherwise have to right-click the editor and tick
// "Check Spelling While Typing" before any underlines appeared. Flipping
// continuousSpellCheckingEnabled here makes the preferences toggle behave
// like users expect.
//
// Windows and Linux WebViews are no-ops; their spell-check is governed by
// the host platform.

use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
fn apply_to_webview(window: &tauri::WebviewWindow, enabled: bool) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let _ = window.with_webview(move |wv| unsafe {
        let wkwebview: *mut AnyObject = wv.inner().cast();
        let _: () = msg_send![wkwebview, setContinuousSpellCheckingEnabled: enabled];
        let _: () = msg_send![wkwebview, setGrammarCheckingEnabled: enabled];
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
