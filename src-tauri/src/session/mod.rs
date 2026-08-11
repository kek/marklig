//! Window session state, launch restore, and open-request routing.
//!
//! Desktop-only: mobile has a single webview and no window management.

pub mod launch;
pub mod registry;
pub mod router;
pub mod store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::files::{canonicalize_path_str, resolve_folder_root};
use launch::{restore_plan, PlannedWindow};
use registry::Registry;
use router::{classify, route, Origin, Route};
use store::{read_session, WindowEntry, WindowMode};

/// True once `run_launch` has created the restored windows. Before that, an
/// incoming `RunEvent::Opened` has nothing to route against and must be
/// buffered — on macOS it fires before the event loop is ready.
static LAUNCH_DONE: AtomicBool = AtomicBool::new(false);

pub fn launch_done() -> bool {
    LAUNCH_DONE.load(Ordering::SeqCst)
}

pub struct SessionState {
    pub registry: Registry,
    pub app_data: PathBuf,
}

impl SessionState {
    pub fn new(app_data: PathBuf) -> Self {
        Self { registry: Registry::new(), app_data }
    }

    fn persist(&self) {
        if let Err(err) = self.registry.persist(&self.app_data) {
            eprintln!("session persist failed: {err}");
        }
    }
}

/// Percent-encode one query-component value. The frontend reads these back
/// with `URLSearchParams`, which performs the matching decode.
fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Build the URL a restored window boots at. The frontend reads its entire
/// initial state from these parameters and decides nothing itself.
fn window_url(planned: &PlannedWindow) -> String {
    let e = &planned.entry;
    let mut params: Vec<String> = Vec::new();
    if let Some(folder) = &e.folder {
        params.push(format!("folder={}", encode_component(folder)));
    }
    if let Some(path) = &e.path {
        params.push(format!("file={}", encode_component(path)));
    }
    params.push(format!("scrollTop={}", e.scroll_top));
    params.push(format!("mode={}", e.mode.as_str()));
    if let Some(dump) = &planned.dump {
        params.push(format!("dump={}", encode_component(dump)));
    }
    format!("/?{}", params.join("&"))
}

/// Create one window and seed the registry with it **synchronously**, from
/// the entry we already hold. Routing must not have to wait for the webview
/// to boot and report — that wait is exactly the race that made cold-start
/// argument handling differ from the warm path.
pub fn spawn_window(app: &AppHandle, planned: &PlannedWindow) -> tauri::Result<()> {
    let e = &planned.entry;
    let mut builder =
        WebviewWindowBuilder::new(app, &e.label, WebviewUrl::App(window_url(planned).into()))
            .title("Märklig")
            .min_inner_size(480.0, 320.0)
            .inner_size(
                if e.width >= 320 { e.width as f64 } else { 1000.0 },
                if e.height >= 240 { e.height as f64 } else { 760.0 },
            );
    // (0, 0) is the "no recorded position" sentinel from `blank_entry`; let
    // the OS cascade the window rather than pinning it to the corner.
    if e.x != 0 || e.y != 0 {
        builder = builder.position(e.x as f64, e.y as f64);
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    builder.build()?;

    if let Some(state) = app.try_state::<SessionState>() {
        state.registry.upsert(e.clone());
        state.persist();
    }
    Ok(())
}

fn raise(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
        }
        let _ = w.set_focus();
    }
}

/// Carry out a routing decision. `emit_to` does not scope a global `listen()`
/// in Tauri v2, so every payload carries its intended label and the frontend
/// ignores anything addressed elsewhere. Do not "simplify" that away.
pub fn apply_route(app: &AppHandle, route: Route) {
    match route {
        Route::Focus { label, load, reveal } => {
            if let Some(path) = load {
                let _ = app.emit_to(
                    label.as_str(),
                    "viewer:open-file",
                    serde_json::json!({ "label": label, "path": path }),
                );
            }
            if let Some(path) = reveal {
                let _ = app.emit_to(
                    label.as_str(),
                    "viewer:reveal-path",
                    serde_json::json!({ "label": label, "path": path }),
                );
            }
            raise(app, &label);
        }
        Route::Adopt { label, folder, load } => {
            if let Some(folder) = folder {
                let _ = app.emit_to(
                    label.as_str(),
                    "viewer:adopt-folder",
                    serde_json::json!({ "label": label, "folder": folder }),
                );
            }
            if let Some(path) = load {
                let _ = app.emit_to(
                    label.as_str(),
                    "viewer:open-file",
                    serde_json::json!({ "label": label, "path": path }),
                );
            }
            raise(app, &label);
        }
        Route::Spawn { folder, file } => {
            let Some(state) = app.try_state::<SessionState>() else { return };
            let label = state.registry.next_label();
            let planned = PlannedWindow {
                entry: WindowEntry {
                    label,
                    folder,
                    path: file,
                    dirty: false,
                    x: 0,
                    y: 0,
                    width: 1000,
                    height: 760,
                    scroll_top: 0.0,
                    mode: WindowMode::Reading,
                    sidebar_visible: None,
                    timestamp_ms: 0,
                },
                dump: None,
            };
            if let Err(err) = spawn_window(app, &planned) {
                eprintln!("spawn window failed: {err}");
            }
        }
    }
}

/// Route a batch of paths. Each path routes against the registry **as updated
/// by the previous one**, so `md a.md b.md` in one folder lands both documents
/// in one window instead of spawning a second.
pub fn open_paths(app: &AppHandle, paths: Vec<String>, requesting: Option<String>) {
    let origin = match requesting {
        Some(label) => Origin::InApp { requesting: label },
        None => Origin::External,
    };
    for raw in paths {
        let canonical = canonicalize_path_str(&raw);
        let Some(target) = classify(&canonical) else { continue };
        let Some(state) = app.try_state::<SessionState>() else { return };
        let windows = state.registry.entries();
        let decision = route(&target, &origin, &windows, &|p| resolve_folder_root(p.to_string()));
        apply_route(app, decision);
    }
}

/// Restore the previous session, then hand over to the router. Called once,
/// from `RunEvent::Ready` — after any launch-time `RunEvent::Opened`.
pub fn run_launch(app: &AppHandle, pending: Vec<String>) {
    let Some(state) = app.try_state::<SessionState>() else { return };
    let session = read_session(&state.app_data);
    let dumps = crate::commands::files::read_all_recovery(app.clone()).unwrap_or_default();
    let plan = restore_plan(session, dumps, &|p| std::path::Path::new(p).exists());

    for planned in &plan {
        if let Err(err) = spawn_window(app, planned) {
            eprintln!("restore window {} failed: {err}", planned.entry.label);
        }
    }
    LAUNCH_DONE.store(true, Ordering::SeqCst);
    if !pending.is_empty() {
        open_paths(app, pending, None);
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn session_report(
    state: tauri::State<'_, SessionState>,
    label: String,
    folder: Option<String>,
    path: Option<String>,
    dirty: bool,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scroll_top: f64,
    mode: String,
    sidebar_visible: Option<bool>,
) {
    state.registry.upsert(WindowEntry {
        label,
        folder,
        path,
        dirty,
        x,
        y,
        width,
        height,
        scroll_top,
        mode: if mode == "edit" { WindowMode::Edit } else { WindowMode::Reading },
        sidebar_visible,
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
    });
    state.persist();
}

/// Drop a window the user closed deliberately, so it is not restored next
/// launch. App-quit deliberately does NOT call this — the entries left behind
/// are exactly the set to bring back.
#[tauri::command]
pub fn session_forget(state: tauri::State<'_, SessionState>, label: String) {
    state.registry.forget(&label);
    state.persist();
}

#[tauri::command]
pub fn session_open_paths(app: AppHandle, paths: Vec<String>, requesting: Option<String>) {
    open_paths(&app, paths, requesting);
}

/// `File → New Window`: a blank window, unconditionally. Not a routing
/// decision — the user asked for a new window, not for a document, and there
/// is no path to route.
#[tauri::command]
pub fn session_new_window(app: AppHandle) {
    apply_route(&app, Route::Spawn { folder: None, file: None });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_url_carries_every_restore_parameter() {
        let planned = PlannedWindow {
            entry: WindowEntry {
                label: "window-2".into(),
                folder: Some("/proj space".into()),
                path: Some("/proj space/a b.md".into()),
                dirty: false,
                x: 5,
                y: 6,
                width: 900,
                height: 700,
                scroll_top: 120.5,
                mode: WindowMode::Edit,
                sidebar_visible: Some(true),
                timestamp_ms: 1,
            },
            dump: Some("/proj space/a b.md".into()),
        };
        let url = window_url(&planned);
        assert!(url.starts_with("/?"), "got {url}");
        assert!(url.contains("folder=%2Fproj%20space"), "got {url}");
        assert!(url.contains("file=%2Fproj%20space%2Fa%20b.md"), "got {url}");
        assert!(url.contains("scrollTop=120.5"), "got {url}");
        assert!(url.contains("mode=edit"), "got {url}");
        assert!(url.contains("dump=%2Fproj%20space%2Fa%20b.md"), "got {url}");
    }

    #[test]
    fn window_url_omits_absent_parameters() {
        let planned = PlannedWindow {
            entry: WindowEntry {
                label: "main".into(),
                folder: None,
                path: None,
                dirty: false,
                x: 0,
                y: 0,
                width: 1000,
                height: 760,
                scroll_top: 0.0,
                mode: WindowMode::Reading,
                sidebar_visible: None,
                timestamp_ms: 0,
            },
            dump: None,
        };
        let url = window_url(&planned);
        assert!(!url.contains("folder="), "got {url}");
        assert!(!url.contains("file="), "got {url}");
        assert!(!url.contains("dump="), "got {url}");
    }
}
