mod commands;

use commands::watcher::WatcherState;

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
