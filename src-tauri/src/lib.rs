mod commands;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::files::read_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
