mod commands;

use commands::watcher::WatcherState;
use tauri::{Emitter, RunEvent};

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
                    let _ = app.emit("file-open-request", paths);
                }
            }
        });
}
