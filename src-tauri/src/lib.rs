mod commands;
#[cfg(target_os = "macos")]
mod mac_tao_patch;

use commands::folder_watcher::FolderWatcherState;
use commands::watcher::WatcherState;
use tauri::RunEvent;
// Only the platforms that emit RunEvent::Opened pull these into scope —
// otherwise the imports would be flagged unused.
#[cfg(target_os = "macos")]
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use tauri::{Emitter, Manager};

pub fn run() {
    let app = tauri::Builder::default()
        .manage(WatcherState::new())
        .manage(FolderWatcherState::new())
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
            commands::files::path_exists,
            commands::files::resolve_folder_root,
            commands::files::reveal_in_file_manager,
            commands::recents_os::register_recent_document,
            commands::folder_watcher::folder_watcher_start,
            commands::folder_watcher::folder_watcher_stop,
            commands::cli_tool::install_cli_tool,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // macOS only: tao 0.35.2 panics in `application:openURLs:` when AppKit
    // hands it a URL whose `absoluteString` is nil (issue #53 here, upstream
    // tauri-apps/tao#1208). On macOS 26 this is hit on cold launch from
    // `open -a Märklig.app <path>` and from Finder file-association launches.
    // Install our nil-filtering swizzle now, after tauri's build() has set
    // up tao's delegate class but before `.run()` enters the event loop.
    #[cfg(target_os = "macos")]
    mac_tao_patch::install();

    app.run(|app, event| match event {
        // macOS only: closing the last window normally terminates the app.
        // Standard Mac behavior is for the app to stay alive until the
        // user picks Quit (Cmd-Q). `code.is_none()` is Tauri's way of
        // distinguishing "user closed the last window" from an explicit
        // `app.exit(code)` (which Cmd-Q / the Quit menu route through).
        #[cfg(target_os = "macos")]
        RunEvent::ExitRequested { code, api, .. } if code.is_none() => {
            api.prevent_exit();
        }
        // macOS only: dock-icon click after we kept the app alive without
        // any windows. Spawn a fresh main window so the user has a way
        // back in — clicking the dock should always do something useful.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } if !has_visible_windows => {
            let _ = spawn_main_window(app, None);
        }
        // macOS / file-association launches deliver paths via RunEvent::Opened
        // (not argv). Forward them to the frontend, which decides whether to
        // replace the current document, prompt-on-dirty, or open in a new
        // window once multi-window UX lands. (The variant is cfg-gated in
        // tauri to the platforms that emit it, so the arm has to match.)
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        RunEvent::Opened { urls } => {
            let paths: Vec<String> = urls
                .into_iter()
                .filter_map(|u| {
                    if u.scheme() == "file" {
                        u.to_file_path()
                            .ok()
                            .and_then(|p| p.to_str().map(str::to_string))
                    } else {
                        None
                    }
                })
                .collect();
            if paths.is_empty() {
                return;
            }
            // Route to a single window, not all of them — when several
            // windows are open, broadcasting would have every window
            // run the open flow simultaneously. Prefer the currently
            // focused window; fall back to "main"; fall back to any
            // window. If no window is alive at all (macOS only, since
            // we prevent_exit on last-window-close above), spawn a
            // fresh main window with the first path.
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
                #[cfg(target_os = "macos")]
                {
                    let _ = spawn_main_window(app, Some(paths[0].clone()));
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = app.emit("file-open-request", paths);
                }
            }
        }
        _ => {}
    });
}

/// Build a fresh "main" webview window matching the config baked into
/// tauri.conf.json. Used on macOS when the app has been kept alive past the
/// last window close and the user takes an action (dock click, recent-doc
/// open) that needs a UI to land in.
#[cfg(target_os = "macos")]
fn spawn_main_window(app: &AppHandle, initial_file: Option<String>) -> tauri::Result<()> {
    let url = match initial_file {
        Some(path) => WebviewUrl::App(format!("/?file={}", encode_query_component(&path)).into()),
        None => WebviewUrl::App("/".into()),
    };
    // Note: drag-drop handler is enabled by default in the Rust builder, so we
    // don't toggle it here — that matches the `dragDropEnabled: true` in
    // tauri.conf.json for the declarative startup window.
    WebviewWindowBuilder::new(app, "main", url)
        .title("Märklig")
        .inner_size(1000.0, 760.0)
        .min_inner_size(480.0, 320.0)
        // Match tauri.conf.json: hide native chrome on macOS so the frontend
        // can draw a custom titlebar that hosts the edit/TOC toggles, file
        // name, and stats. `hidden_title(true)` keeps the traffic lights and
        // suppresses the centred title text.
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .build()?;
    Ok(())
}

/// Minimal RFC 3986 percent-encoding for a single query-component value.
/// We can't pull in `urlencoding` for one call site; the frontend reads the
/// `?file=` param via `URLSearchParams`, which does the matching decode.
#[cfg(target_os = "macos")]
fn encode_query_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
