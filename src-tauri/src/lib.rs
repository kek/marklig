mod commands;

use commands::watcher::WatcherState;
use tauri::{Emitter, Manager, RunEvent};

pub fn run() {
    tauri::Builder::default()
        .manage(WatcherState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::watcher::watcher_start,
            commands::watcher::watcher_stop,
            commands::watcher::watcher_mark_self_write,
            commands::files::write_recovery,
            commands::files::read_all_recovery,
            commands::files::clear_recovery,
            commands::files::list_markdown_files,
            commands::files::is_directory,
            commands::files::reveal_in_file_manager,
            commands::recents_os::register_recent_document,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS / file-association launches deliver paths via RunEvent::Opened
            // (not argv). Forward them to the frontend, which decides whether to
            // replace the current document, prompt-on-dirty, or open in a new
            // window once multi-window UX lands.
            if let RunEvent::Opened { urls } = event {
                let paths: Vec<String> = urls
                    .into_iter()
                    .filter_map(|u| {
                        if u.scheme() == "file" {
                            u.to_file_path().ok().and_then(|p| p.to_str().map(str::to_string))
                        } else {
                            None
                        }
                    })
                    .collect();
                if !paths.is_empty() {
                    // Route to a single window, not all of them — when several
                    // windows are open, broadcasting would have every window
                    // run the open flow simultaneously. Prefer the currently
                    // focused window; fall back to "main"; fall back to any
                    // window; last-resort broadcast (covers the cold-start
                    // case where no webview has finished registering yet).
                    let target = app
                        .webview_windows()
                        .into_iter()
                        .find(|(_, w)| w.is_focused().unwrap_or(false))
                        .or_else(|| {
                            app.webview_windows()
                                .into_iter()
                                .find(|(label, _)| label == "main")
                        })
                        .or_else(|| app.webview_windows().into_iter().next());
                    if let Some((label, win)) = target {
                        // Bring the chosen window forward so the user sees the
                        // freshly opened document, not whatever was on top.
                        let _ = win.set_focus();
                        let _ = app.emit_to(label.as_str(), "file-open-request", paths);
                    } else {
                        let _ = app.emit("file-open-request", paths);
                    }
                }
            }
        });
}
