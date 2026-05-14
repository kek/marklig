// Sync the in-app spell-check toggle with WebKit's NSUserDefaults state.
//
// On macOS WKWebView's continuous spell-checking state is persisted in
// NSUserDefaults under the keys `WebContinuousSpellCheckingEnabled` and
// `WebGrammarCheckingEnabled` (the same keys Safari, Mail, MarkEdit, etc.
// use). WebKit consults these at WKWebView creation, so the change takes
// effect when the app — or any new webview window — starts up.
//
// We can't reliably flip the running webview live: WKWebView doesn't
// expose `_setContinuousSpellCheckingEnabled:` on the wry subclass, and
// the responder-chain action `toggleContinuousSpellChecking:` only fires
// when the editor itself is first responder (not when the prefs window
// is focused). The right-click "Check Spelling While Typing" menu does
// the live flip when the user is in the editor; our NSUserDefaults write
// then keeps that choice for the next launch. The two surfaces stay in
// agreement.
//
// Windows and Linux WebViews are no-ops — their spell-check is governed
// by the host platform.

use tauri::AppHandle;

#[cfg(target_os = "macos")]
fn write_default(enabled: bool) {
    use objc2_foundation::{NSString, NSUserDefaults};
    let defaults = NSUserDefaults::standardUserDefaults();
    let spell_key = NSString::from_str("WebContinuousSpellCheckingEnabled");
    let grammar_key = NSString::from_str("WebGrammarCheckingEnabled");
    defaults.setBool_forKey(enabled, &spell_key);
    defaults.setBool_forKey(enabled, &grammar_key);
}

#[cfg(not(target_os = "macos"))]
fn write_default(_enabled: bool) {}

#[tauri::command]
pub fn set_continuous_spell_checking(_app: AppHandle, enabled: bool) -> Result<(), String> {
    write_default(enabled);
    Ok(())
}
