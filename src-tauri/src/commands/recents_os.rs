// OS-level recent-documents integration. macOS calls
// NSDocumentController.noteNewRecentDocumentURL so the file shows up in
// surfaces like the Dock icon's right-click menu and the system "Recent"
// sources. Windows / Linux equivalents (Jump List / RecentManager) are
// no-ops here — a future iteration can add them.

use tauri::AppHandle;

#[cfg(target_os = "macos")]
fn note_on_main(_app: &AppHandle, path: &str) {
    use objc2_app_kit::NSDocumentController;
    use objc2_foundation::{MainThreadMarker, NSString, NSURL};

    // Caller guarantees we're on the main thread (we hop here via
    // run_on_main_thread). MainThreadMarker::new() returns Some only on the
    // main thread; assert that and proceed.
    let Some(mtm) = MainThreadMarker::new() else { return };
    let ns_path = NSString::from_str(path);
    let url = NSURL::fileURLWithPath(&ns_path);
    let controller = NSDocumentController::sharedDocumentController(mtm);
    controller.noteNewRecentDocumentURL(&url);
}

#[cfg(not(target_os = "macos"))]
fn note_on_main(_app: &AppHandle, _path: &str) {
    // Stub. Windows Jump List and GTK RecentManager would slot in here.
}

#[tauri::command]
pub fn register_recent_document(app: AppHandle, path: String) -> Result<(), String> {
    let app_clone = app.clone();
    // NSDocumentController must be touched on the main thread; Tauri command
    // handlers run on a worker thread. run_on_main_thread schedules the call
    // and returns immediately. Failure to schedule is non-fatal — the OS
    // recents cache is best-effort.
    let _ = app
        .run_on_main_thread(move || {
            note_on_main(&app_clone, &path);
        })
        .map_err(|e| e.to_string());
    Ok(())
}
