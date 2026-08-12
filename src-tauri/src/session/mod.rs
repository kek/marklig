//! Window session state, launch restore, and open-request routing.
//!
//! Desktop-only: mobile has a single webview and no window management.

pub mod launch;
pub mod registry;
pub mod router;
pub mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::files::{canonicalize_path_str, resolve_folder_root};
use launch::{blank_entry, restore_plan, PlannedWindow};
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
    /// Label of the window that currently owns the application menu. Elected
    /// first-come rather than fixed to `main`: with windows restored under
    /// their recorded labels, a session may contain no window called `main`
    /// at all, and a label-gated menu would then never be built.
    menu_owner: Mutex<Option<String>>,
}

impl SessionState {
    pub fn new(app_data: PathBuf) -> Self {
        Self { registry: Registry::new(), app_data, menu_owner: Mutex::new(None) }
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
    // Absent must stay distinguishable from false: no preference recorded
    // means the frontend falls back to its own heuristic (shouldShowSidebar),
    // whereas an explicit false means the user hid it and that must survive
    // a restart.
    if let Some(visible) = e.sidebar_visible {
        params.push(format!("sidebar={}", visible));
    }
    if let Some(dump) = &planned.dump {
        params.push(format!("dump={}", encode_component(dump)));
    }
    if let Some(reveal) = &planned.reveal {
        params.push(format!("reveal={}", encode_component(reveal)));
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

/// One message for a window that **already exists**, and therefore already
/// ran its JS and installed its listeners. Windows this batch is about to
/// create never get one — their instructions ride their URL instead.
///
/// `emit_to` does not scope a global `listen()` in Tauri v2, so every payload
/// carries its intended label and the frontend ignores anything addressed
/// elsewhere (#145). Do not "simplify" that away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    OpenFile { label: String, path: String },
    Reveal { label: String, path: String },
    /// Take over a blank window. Deliberately **one** message even when it
    /// carries a document: as two, the adopt handler's project-fallback
    /// buffer races the requested file and usually wins, so the user ends up
    /// staring at README.md instead of what they asked for.
    Adopt { label: String, folder: String, load: Option<String> },
}

impl Delivery {
    fn emit(&self, app: &AppHandle) {
        let (label, event, payload) = match self {
            Delivery::OpenFile { label, path } => (
                label,
                "viewer:open-file",
                serde_json::json!({ "label": label, "path": path }),
            ),
            Delivery::Reveal { label, path } => (
                label,
                "viewer:reveal-path",
                serde_json::json!({ "label": label, "path": path }),
            ),
            Delivery::Adopt { label, folder, load } => (
                label,
                "viewer:adopt-folder",
                serde_json::json!({ "label": label, "folder": folder, "path": load }),
            ),
        };
        let _ = app.emit_to(label.as_str(), event, payload);
    }
}

/// The delivery plan for one batch of open requests.
///
/// Routing decides *what* should happen; this decides *how it is delivered*,
/// and the split matters because the two answers differ by target: a window
/// that already exists is told by event, a window that does not exist yet is
/// told by URL. Getting that backwards loses the instruction with no error —
/// which is exactly what cold start used to do.
#[derive(Debug, Default)]
pub struct Batch {
    /// Windows to create, with every decision already folded in.
    pub plan: Vec<PlannedWindow>,
    /// Messages for windows that existed before this batch began.
    pub deliveries: Vec<Delivery>,
    /// Windows to bring forward, in decision order — applied last, so a
    /// window created by this batch is already there to be raised.
    pub raises: Vec<String>,
    /// Label → index into `plan`, so a later decision can be folded into an
    /// earlier planned window rather than emitted at it.
    planned_at: HashMap<String, usize>,
}

impl Batch {
    /// Start from a launch plan. Every window in it is pending creation, so
    /// every decision landing on one is folded rather than emitted.
    pub fn from_plan(plan: Vec<PlannedWindow>) -> Self {
        let planned_at =
            plan.iter().enumerate().map(|(i, p)| (p.entry.label.clone(), i)).collect();
        Self { plan, deliveries: Vec::new(), raises: Vec::new(), planned_at }
    }

    /// Fold one decision in, updating `reg` so the next path in the batch
    /// routes against the world as this decision leaves it.
    fn apply(&mut self, reg: &Registry, decision: Route) {
        match decision {
            Route::Focus { label, load, reveal } => {
                if let Some(&i) = self.planned_at.get(&label) {
                    if let Some(path) = load {
                        self.plan[i].entry.path = Some(path);
                        // The recorded scroll offset belongs to the document
                        // this window had open last session, not to the one
                        // the user just asked for. Carrying it over boots the
                        // new file scrolled to a meaningless position.
                        // `maybeRestorePositionFor` still applies a saved
                        // position for the incoming file if one exists.
                        self.plan[i].entry.scroll_top = 0.0;
                    }
                    if let Some(dir) = reveal {
                        self.plan[i].reveal = Some(dir);
                    }
                    reg.upsert(self.plan[i].entry.clone());
                } else {
                    if let Some(path) = load {
                        reg_set(reg, &label, |e| e.path = Some(path.clone()));
                        self.deliveries.push(Delivery::OpenFile { label: label.clone(), path });
                    }
                    if let Some(path) = reveal {
                        self.deliveries.push(Delivery::Reveal { label: label.clone(), path });
                    }
                }
                self.raises.push(label);
            }
            Route::Adopt { label, folder, load } => {
                if let Some(&i) = self.planned_at.get(&label) {
                    if folder.is_some() {
                        self.plan[i].entry.folder = folder;
                    }
                    if load.is_some() {
                        self.plan[i].entry.path = load;
                    }
                    reg.upsert(self.plan[i].entry.clone());
                } else {
                    reg_set(reg, &label, |e| {
                        if folder.is_some() {
                            e.folder = folder.clone();
                        }
                        if load.is_some() {
                            e.path = load.clone();
                        }
                    });
                    match (folder, load) {
                        (Some(folder), load) => {
                            self.deliveries.push(Delivery::Adopt {
                                label: label.clone(),
                                folder,
                                load,
                            });
                        }
                        // No folder to adopt — a bare document open is all
                        // that is left, and that needs no second message.
                        (None, Some(path)) => {
                            self.deliveries
                                .push(Delivery::OpenFile { label: label.clone(), path });
                        }
                        (None, None) => {}
                    }
                }
                self.raises.push(label);
            }
            Route::Spawn { folder, file } => {
                let label = reg.next_label();
                let entry = WindowEntry { folder, path: file, ..blank_entry(label.clone()) };
                reg.upsert(entry.clone());
                self.planned_at.insert(label, self.plan.len());
                self.plan.push(PlannedWindow { entry, dump: None, reveal: None });
            }
        }
    }

    /// Create the planned windows, deliver to the pre-existing ones, raise.
    fn commit(self, app: &AppHandle, state: &SessionState) {
        for planned in &self.plan {
            if let Err(err) = spawn_window(app, planned) {
                eprintln!("create window {} failed: {err}", planned.entry.label);
                // Don't leave a window in the routing map that never opened —
                // a later path would route into a window that isn't there.
                state.registry.forget(&planned.entry.label);
            }
        }
        for delivery in &self.deliveries {
            delivery.emit(app);
        }
        for label in &self.raises {
            raise(app, label);
        }
    }
}

/// Mutate a live registry entry in place, if it is still there.
fn reg_set(reg: &Registry, label: &str, f: impl FnOnce(&mut WindowEntry)) {
    if let Some(mut e) = reg.entries().into_iter().find(|e| e.label == label) {
        f(&mut e);
        reg.upsert(e);
    }
}

/// Route a batch of paths into `batch`. Each path routes against the registry
/// **as updated by the previous one**, so `md a.md b.md` in one folder lands
/// both documents in one window instead of spawning a second.
///
/// Pure apart from the filesystem probes in `classify` and `folder_root_of` —
/// no app handle — so the resulting `Batch` is directly assertable in tests.
/// That is deliberate: asserting on the `Route` values proves only that the
/// decision was right, and every defect this function exists to prevent was a
/// right decision delivered where nothing was listening.
pub fn route_batch(
    batch: &mut Batch,
    reg: &Registry,
    paths: Vec<String>,
    origin: &Origin,
    folder_root_of: &dyn Fn(&str) -> String,
) {
    for raw in paths {
        let canonical = canonicalize_path_str(&raw);
        let Some(target) = classify(&canonical) else { continue };
        let windows = reg.entries();
        let decision = route(&target, origin, &windows, folder_root_of);
        batch.apply(reg, decision);
    }
}

/// Carry out a single routing decision against the live app. Used by the
/// callers that produce one decision out of band — `File → New Window` and
/// the macOS dock-icon reopen.
pub fn apply_route(app: &AppHandle, route: Route) {
    let Some(state) = app.try_state::<SessionState>() else { return };
    let mut batch = Batch::default();
    batch.apply(&state.registry, route);
    batch.commit(app, &state);
}

/// Route a batch of paths against the running app.
pub fn open_paths(app: &AppHandle, paths: Vec<String>, requesting: Option<String>) {
    let origin = match requesting {
        Some(label) => Origin::InApp { requesting: label },
        None => Origin::External,
    };
    let Some(state) = app.try_state::<SessionState>() else { return };
    let mut batch = Batch::default();
    route_batch(&mut batch, &state.registry, paths, &origin, &|p| {
        resolve_folder_root(p.to_string())
    });
    batch.commit(app, &state);
}

/// Restore the previous session, then hand over to the router. Called once,
/// from `RunEvent::Ready` — after any launch-time `RunEvent::Opened`.
///
/// Plan, route, fold, *then* create. The order is the whole point: a launch
/// argument's decision has to reach a window that does not exist yet, and the
/// only channel a not-yet-created window has is its URL. Spawning first and
/// emitting after — which is what this used to do — drops the argument on the
/// floor, because the webview has no listeners until its JS has run.
pub fn run_launch(app: &AppHandle, pending: Vec<String>) {
    let Some(state) = app.try_state::<SessionState>() else { return };
    let session = read_session(&state.app_data);
    let dumps = crate::commands::files::read_all_recovery(app.clone()).unwrap_or_default();
    let plan = restore_plan(session, dumps, &|p| std::path::Path::new(p).exists());

    // Seed the registry from the plan before routing: the argument must see
    // the windows the restore is about to create, or it invents a duplicate.
    for planned in &plan {
        state.registry.upsert(planned.entry.clone());
    }

    let mut batch = Batch::from_plan(plan);
    route_batch(&mut batch, &state.registry, pending, &Origin::External, &|p| {
        resolve_folder_root(p.to_string())
    });
    batch.commit(app, &state);
    LAUNCH_DONE.store(true, Ordering::SeqCst);
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
pub fn session_forget(app: AppHandle, state: tauri::State<'_, SessionState>, label: String) {
    state.registry.forget(&label);
    state.persist();
    reelect_menu_owner(&app, &state, &label);
}

/// Claim the application menu for `label`. Exactly one window may own it —
/// installing it from several means the last writer wins on macOS, which is
/// what produced the "Cmd-W closes the most recently opened window" bug.
///
/// Ownership is elected, not assigned by label: `main` is a name the restore
/// happens to reuse, not a role, and a session restored from `{window-2}`
/// contains no window called `main` at all. Gating on the label there means
/// the app runs with no menu for the rest of the session, with no way back.
#[tauri::command]
pub fn session_claim_menu(state: tauri::State<'_, SessionState>, label: String) -> bool {
    let mut owner = state.menu_owner.lock();
    match owner.as_deref() {
        Some(current) => current == label,
        None => {
            *owner = Some(label);
            true
        }
    }
}

/// Hand the menu to another live window when its owner goes away. Called on
/// deliberate close; app-quit needs no successor.
fn reelect_menu_owner(app: &AppHandle, state: &SessionState, closing: &str) {
    {
        let mut owner = state.menu_owner.lock();
        if owner.as_deref() != Some(closing) {
            return;
        }
        *owner = None;
    }
    let successor = state
        .registry
        .entries()
        .into_iter()
        .map(|e| e.label)
        .find(|l| l != closing && app.get_webview_window(l).is_some());
    let Some(successor) = successor else { return };
    *state.menu_owner.lock() = Some(successor.clone());
    let _ = app.emit_to(
        successor.as_str(),
        "viewer:claim-menu",
        serde_json::json!({ "label": successor }),
    );
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
            reveal: Some("/proj space/docs".into()),
        };
        let url = window_url(&planned);
        assert!(url.starts_with("/?"), "got {url}");
        assert!(url.contains("folder=%2Fproj%20space"), "got {url}");
        assert!(url.contains("file=%2Fproj%20space%2Fa%20b.md"), "got {url}");
        assert!(url.contains("scrollTop=120.5"), "got {url}");
        assert!(url.contains("mode=edit"), "got {url}");
        assert!(url.contains("sidebar=true"), "got {url}");
        assert!(url.contains("dump=%2Fproj%20space%2Fa%20b.md"), "got {url}");
        assert!(url.contains("reveal=%2Fproj%20space%2Fdocs"), "got {url}");
    }

    #[test]
    fn window_url_carries_sidebar_hidden() {
        let planned = PlannedWindow {
            entry: WindowEntry {
                label: "window-3".into(),
                folder: None,
                path: None,
                dirty: false,
                x: 0,
                y: 0,
                width: 1000,
                height: 760,
                scroll_top: 0.0,
                mode: WindowMode::Reading,
                sidebar_visible: Some(false),
                timestamp_ms: 0,
            },
            dump: None,
            reveal: None,
        };
        let url = window_url(&planned);
        assert!(url.contains("sidebar=false"), "got {url}");
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
            reveal: None,
        };
        let url = window_url(&planned);
        assert!(!url.contains("folder="), "got {url}");
        assert!(!url.contains("file="), "got {url}");
        assert!(!url.contains("dump="), "got {url}");
        assert!(!url.contains("sidebar="), "got {url}");
        assert!(!url.contains("reveal="), "got {url}");
    }

    fn win(label: &str, folder: Option<&str>, path: Option<&str>) -> WindowEntry {
        WindowEntry {
            folder: folder.map(str::to_string),
            path: path.map(str::to_string),
            ..blank_entry(label.to_string())
        }
    }

    fn planned(label: &str, folder: Option<&str>) -> PlannedWindow {
        PlannedWindow { entry: win(label, folder, None), dump: None, reveal: None }
    }

    /// A window that does not exist yet must be told through its URL. If any
    /// of these folds became an emit again, the instruction would be dropped
    /// by a webview that has not installed its listeners.
    #[test]
    fn a_focus_load_on_a_planned_window_is_folded_into_its_url() {
        let reg = Registry::new();
        reg.upsert(win("main", Some("/proj"), None));
        let mut batch = Batch::from_plan(vec![planned("main", Some("/proj"))]);

        batch.apply(
            &reg,
            Route::Focus {
                label: "main".into(),
                load: Some("/proj/x.md".into()),
                reveal: None,
            },
        );

        assert_eq!(batch.plan[0].entry.path.as_deref(), Some("/proj/x.md"));
        assert!(batch.deliveries.is_empty(), "must not emit at a window that does not exist");
        assert_eq!(batch.raises, vec!["main".to_string()]);
    }

    /// The restored entry carries the scroll offset of the document it had
    /// open LAST session. Folding a different document in must clear it, or
    /// `md /proj/other.md` boots the new file scrolled to a position that
    /// belongs to a file the user is no longer looking at.
    #[test]
    fn folding_a_new_document_clears_the_previous_documents_scroll_offset() {
        let reg = Registry::new();
        let mut restored = win("main", Some("/proj"), Some("/proj/old.md"));
        restored.scroll_top = 4200.0;
        reg.upsert(restored.clone());
        let mut batch = Batch::from_plan(vec![PlannedWindow {
            entry: restored,
            dump: None,
            reveal: None,
        }]);

        batch.apply(
            &reg,
            Route::Focus {
                label: "main".into(),
                load: Some("/proj/new.md".into()),
                reveal: None,
            },
        );

        assert_eq!(batch.plan[0].entry.path.as_deref(), Some("/proj/new.md"));
        assert_eq!(batch.plan[0].entry.scroll_top, 0.0);
    }

    /// The complement: a reveal changes no document, so the window's own
    /// scroll position must survive.
    #[test]
    fn folding_only_a_reveal_leaves_the_scroll_offset_alone() {
        let reg = Registry::new();
        let mut restored = win("main", Some("/proj"), Some("/proj/old.md"));
        restored.scroll_top = 4200.0;
        reg.upsert(restored.clone());
        let mut batch = Batch::from_plan(vec![PlannedWindow {
            entry: restored,
            dump: None,
            reveal: None,
        }]);

        batch.apply(
            &reg,
            Route::Focus {
                label: "main".into(),
                load: None,
                reveal: Some("/proj/docs".into()),
            },
        );

        assert_eq!(batch.plan[0].entry.scroll_top, 4200.0);
        assert_eq!(batch.plan[0].reveal.as_deref(), Some("/proj/docs"));
    }

    #[test]
    fn a_focus_reveal_on_a_planned_window_is_folded_into_its_url() {
        let reg = Registry::new();
        reg.upsert(win("main", Some("/proj"), None));
        let mut batch = Batch::from_plan(vec![planned("main", Some("/proj"))]);

        batch.apply(
            &reg,
            Route::Focus {
                label: "main".into(),
                load: None,
                reveal: Some("/proj/docs".into()),
            },
        );

        assert_eq!(batch.plan[0].reveal.as_deref(), Some("/proj/docs"));
        assert!(batch.deliveries.is_empty());
    }

    #[test]
    fn an_adopt_on_a_planned_window_is_folded_into_its_url() {
        let reg = Registry::new();
        reg.upsert(win("main", None, None));
        let mut batch = Batch::from_plan(vec![planned("main", None)]);

        batch.apply(
            &reg,
            Route::Adopt {
                label: "main".into(),
                folder: Some("/proj".into()),
                load: Some("/proj/notes.md".into()),
            },
        );

        assert_eq!(batch.plan[0].entry.folder.as_deref(), Some("/proj"));
        assert_eq!(batch.plan[0].entry.path.as_deref(), Some("/proj/notes.md"));
        assert!(batch.deliveries.is_empty());
        // The fold is visible to the next path in the batch.
        assert_eq!(reg.entries()[0].folder.as_deref(), Some("/proj"));
    }

    /// The C2 defect: two messages for one Adopt let the adopt handler's
    /// project-fallback buffer race the requested document and win.
    #[test]
    fn an_adopt_with_a_load_on_a_live_window_is_exactly_one_message() {
        let reg = Registry::new();
        reg.upsert(win("main", None, None));
        let mut batch = Batch::default();

        batch.apply(
            &reg,
            Route::Adopt {
                label: "main".into(),
                folder: Some("/proj".into()),
                load: Some("/proj/notes.md".into()),
            },
        );

        assert_eq!(
            batch.deliveries,
            vec![Delivery::Adopt {
                label: "main".into(),
                folder: "/proj".into(),
                load: Some("/proj/notes.md".into()),
            }]
        );
    }

    #[test]
    fn an_adopt_without_a_folder_degrades_to_a_plain_open() {
        let reg = Registry::new();
        reg.upsert(win("main", None, None));
        let mut batch = Batch::default();

        batch.apply(
            &reg,
            Route::Adopt { label: "main".into(), folder: None, load: Some("/x.md".into()) },
        );

        assert_eq!(
            batch.deliveries,
            vec![Delivery::OpenFile { label: "main".into(), path: "/x.md".into() }]
        );
    }

    #[test]
    fn a_focus_on_a_live_window_still_emits() {
        // The warm path is the one that works; it must keep working.
        let reg = Registry::new();
        reg.upsert(win("window-2", Some("/proj"), None));
        let mut batch = Batch::default();

        batch.apply(
            &reg,
            Route::Focus {
                label: "window-2".into(),
                load: Some("/proj/x.md".into()),
                reveal: None,
            },
        );

        assert_eq!(
            batch.deliveries,
            vec![Delivery::OpenFile { label: "window-2".into(), path: "/proj/x.md".into() }]
        );
    }

    #[test]
    fn a_spawn_becomes_a_planned_window_a_later_decision_can_fold_into() {
        let reg = Registry::new();
        reg.upsert(win("main", Some("/other"), None));
        let mut batch = Batch::default();

        batch.apply(
            &reg,
            Route::Spawn { folder: Some("/proj".into()), file: Some("/proj/a.md".into()) },
        );
        let label = batch.plan[0].entry.label.clone();
        batch.apply(
            &reg,
            Route::Focus { label: label.clone(), load: Some("/proj/b.md".into()), reveal: None },
        );

        assert_eq!(batch.plan.len(), 1, "the second path must not add a window");
        assert_eq!(batch.plan[0].entry.folder.as_deref(), Some("/proj"));
        assert_eq!(batch.plan[0].entry.path.as_deref(), Some("/proj/b.md"));
        assert!(
            batch.deliveries.is_empty(),
            "a window spawned by this same batch has no listeners yet"
        );
    }
}
