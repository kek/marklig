//! Cold-launch scenarios: restore the session, then route the arguments.
//!
//! Plan-then-route is the whole contract — a launch argument must see the
//! restored windows, or it invents a duplicate. Playwright cannot drive a
//! multi-process cold launch, so this is where that guarantee is enforced.

#![cfg(not(any(target_os = "android", target_os = "ios")))]

use marklig_lib::session::launch::restore_plan;
use marklig_lib::session::registry::Registry;
use marklig_lib::session::router::{classify, route, Origin, Route};
use marklig_lib::session::store::{SessionFile, WindowEntry, WindowMode, SESSION_VERSION};
use marklig_lib::session::{route_batch, Batch, Delivery};

fn entry(label: &str, folder: &str, path: Option<&str>) -> WindowEntry {
    WindowEntry {
        label: label.to_string(),
        folder: Some(folder.to_string()),
        path: path.map(str::to_string),
        dirty: false,
        x: 0,
        y: 0,
        width: 1000,
        height: 760,
        scroll_top: 0.0,
        mode: WindowMode::Reading,
        sidebar_visible: None,
        timestamp_ms: 1,
    }
}

/// Run a launch's **decision** layer: plan, seed the registry, route each
/// argument, and return the resulting window set plus the routes taken.
///
/// This helper reimplements `apply_route`'s registry effect, so it proves
/// only that the router decided correctly. It cannot see whether the decision
/// was ever delivered — use `launch_batch` below for that.
fn launch(session: SessionFile, args: &[&str]) -> (Registry, Vec<Route>) {
    let plan = restore_plan(session, vec![], &|p| std::path::Path::new(p).exists());
    let reg = Registry::new();
    for planned in &plan {
        reg.upsert(planned.entry.clone());
    }
    let mut routes = Vec::new();
    for arg in args {
        let Some(target) = classify(arg) else { continue };
        let windows = reg.entries();
        let parent_of = |p: &str| {
            std::path::Path::new(p)
                .parent()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        let decision = route(&target, &Origin::External, &windows, &parent_of);
        // Mirror what `apply_route` does to the registry.
        if let Route::Spawn { folder, file } = &decision {
            let label = reg.next_label();
            let mut e = entry(&label, folder.as_deref().unwrap_or(""), file.as_deref());
            e.folder = folder.clone();
            reg.upsert(e);
        }
        routes.push(decision);
    }
    (reg, routes)
}

fn folders(reg: &Registry) -> Vec<Option<String>> {
    reg.entries().into_iter().map(|e| e.folder).collect()
}

#[test]
fn cold_empty_session_without_arguments_opens_one_welcome_window() {
    let (reg, _) = launch(SessionFile::default(), &[]);
    assert_eq!(reg.entries().len(), 1);
    assert!(reg.entries()[0].folder.is_none());
}

#[test]
fn cold_empty_session_with_a_file_argument_roots_the_window_at_its_folder() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("notes.md");
    std::fs::write(&file, "# hi").unwrap();

    let (reg, routes) = launch(SessionFile::default(), &[file.to_str().unwrap()]);
    assert_eq!(reg.entries().len(), 1, "must not add a second window");
    match &routes[0] {
        Route::Adopt { folder, load, .. } => {
            assert_eq!(folder.as_deref(), Some(dir.path().to_str().unwrap()));
            assert_eq!(load.as_deref(), Some(file.to_str().unwrap()));
        }
        other => panic!("expected the sole blank window to be adopted, got {other:?}"),
    }
}

#[test]
fn cold_two_window_session_without_arguments_restores_exactly_two() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let session = SessionFile {
        version: SESSION_VERSION,
        windows: vec![
            entry("main", a.path().to_str().unwrap(), None),
            entry("window-2", b.path().to_str().unwrap(), None),
        ],
    };
    let (reg, _) = launch(session, &[]);
    assert_eq!(reg.entries().len(), 2);
}

#[test]
fn cold_session_plus_a_file_already_covered_does_not_add_a_window() {
    // The headline defect: the argument must see the restored windows.
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let file = b.path().join("notes.md");
    std::fs::write(&file, "# hi").unwrap();
    let session = SessionFile {
        version: SESSION_VERSION,
        windows: vec![
            entry("main", a.path().to_str().unwrap(), None),
            entry("window-2", b.path().to_str().unwrap(), None),
        ],
    };

    let (reg, routes) = launch(session, &[file.to_str().unwrap()]);
    assert_eq!(reg.entries().len(), 2, "no duplicate window for a covered file");
    assert_eq!(
        routes[0],
        Route::Focus {
            label: "window-2".into(),
            load: Some(file.to_str().unwrap().to_string()),
            reveal: None,
        }
    );
    // The restored window's own project survived the argument.
    assert!(folders(&reg).contains(&Some(a.path().to_str().unwrap().to_string())));
}

#[test]
fn cold_session_plus_an_uncovered_directory_adds_exactly_one_window() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let c = tempfile::tempdir().unwrap();
    let session = SessionFile {
        version: SESSION_VERSION,
        windows: vec![
            entry("main", a.path().to_str().unwrap(), None),
            entry("window-2", b.path().to_str().unwrap(), None),
        ],
    };

    let (reg, routes) = launch(session, &[c.path().to_str().unwrap()]);
    assert_eq!(reg.entries().len(), 3);
    assert!(matches!(routes[0], Route::Spawn { .. }));
}

#[test]
fn cold_session_plus_a_subdirectory_reveals_without_adding_a_window() {
    let a = tempfile::tempdir().unwrap();
    let sub = a.path().join("docs");
    std::fs::create_dir(&sub).unwrap();
    let session = SessionFile {
        version: SESSION_VERSION,
        windows: vec![entry("main", a.path().to_str().unwrap(), None)],
    };

    let (reg, routes) = launch(session, &[sub.to_str().unwrap()]);
    assert_eq!(reg.entries().len(), 1);
    assert_eq!(
        routes[0],
        Route::Focus {
            label: "main".into(),
            load: None,
            reveal: Some(sub.to_str().unwrap().to_string()),
        }
    );
}

#[test]
fn a_session_with_two_entries_on_one_folder_restores_one_window() {
    let a = tempfile::tempdir().unwrap();
    let mut older = entry("main", a.path().to_str().unwrap(), None);
    older.timestamp_ms = 1;
    let mut newer = entry("window-2", a.path().to_str().unwrap(), None);
    newer.timestamp_ms = 9;

    let (reg, _) = launch(SessionFile { version: SESSION_VERSION, windows: vec![older, newer] }, &[]);
    assert_eq!(reg.entries().len(), 1);
    assert_eq!(reg.entries()[0].label, "window-2");
}

#[test]
fn two_file_arguments_in_one_folder_share_a_single_window() {
    let a = tempfile::tempdir().unwrap();
    let x = a.path().join("x.md");
    let y = a.path().join("y.md");
    std::fs::write(&x, "x").unwrap();
    std::fs::write(&y, "y").unwrap();

    let (reg, _) = launch(SessionFile::default(), &[x.to_str().unwrap(), y.to_str().unwrap()]);
    assert_eq!(reg.entries().len(), 1, "second file must land in the first window");
}

// ---------------------------------------------------------------------------
// Delivery. Everything above asserts on `Route` values, which is one half of
// the story: a launch argument routed to a window that has not booted yet is
// a correct decision that reaches nobody. `emit_to` resolves against the
// listener table a webview fills in when its JS calls `listen()`, so a window
// created moments earlier in the same synchronous block silently drops the
// event. These tests assert on the *plan* — the labels, and what each entry
// actually carries into its URL — which is the only thing a not-yet-created
// window can be told through.
// ---------------------------------------------------------------------------

/// Run a launch the way `run_launch` does: plan, seed the registry from the
/// plan, route the arguments **folding each decision back into the plan**,
/// and hand back the plan that would be spawned.
fn launch_batch(session: SessionFile, args: &[&str]) -> Batch {
    let plan = restore_plan(session, vec![], &|p| std::path::Path::new(p).exists());
    let reg = Registry::new();
    for planned in &plan {
        reg.upsert(planned.entry.clone());
    }
    let mut batch = Batch::from_plan(plan);
    route_batch(
        &mut batch,
        &reg,
        args.iter().map(|s| s.to_string()).collect(),
        &Origin::External,
        &|p| {
            std::path::Path::new(p)
                .parent()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_default()
        },
    );
    batch
}

/// Canonical spelling of an existing path. `route_batch` canonicalizes every
/// incoming path (issue #99), and on macOS `/var` is a symlink to
/// `/private/var`, so a temp dir reaches the router under a different name
/// than `tempfile` handed us.
fn canon(p: &std::path::Path) -> String {
    std::fs::canonicalize(p).unwrap().to_string_lossy().into_owned()
}

/// `(label, folder, path)` for each window the launch would create.
fn windows_of(batch: &Batch) -> Vec<(String, Option<String>, Option<String>)> {
    batch
        .plan
        .iter()
        .map(|p| (p.entry.label.clone(), p.entry.folder.clone(), p.entry.path.clone()))
        .collect()
}

#[test]
fn cold_empty_session_with_a_file_argument_carries_it_in_the_windows_url() {
    // The spec's flagship fix. Spawning the welcome window and *then*
    // emitting `viewer:open-file` at it leaves the user on a blank buffer:
    // the webview has no listener yet. Both facts must ride the URL.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("notes.md");
    std::fs::write(&file, "# hi").unwrap();

    let batch = launch_batch(SessionFile::default(), &[file.to_str().unwrap()]);

    assert_eq!(batch.plan.len(), 1, "must not add a second window");
    assert_eq!(batch.plan[0].entry.folder.as_deref(), Some(canon(dir.path()).as_str()));
    assert_eq!(batch.plan[0].entry.path.as_deref(), Some(canon(&file).as_str()));
    assert!(
        batch.deliveries.is_empty(),
        "nothing may be emitted at a window this launch has not created yet"
    );
}

#[test]
fn cold_session_plus_a_covered_file_carries_it_in_that_windows_url() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let file = b.path().join("notes.md");
    std::fs::write(&file, "# hi").unwrap();
    // A restored session holds canonical paths — that is what the reporter
    // writes — so spell them the way the router will.
    let session = SessionFile {
        version: SESSION_VERSION,
        windows: vec![
            entry("main", &canon(a.path()), None),
            entry("window-2", &canon(b.path()), None),
        ],
    };

    let batch = launch_batch(session, &[file.to_str().unwrap()]);

    let windows = windows_of(&batch);
    assert_eq!(windows.len(), 2, "no duplicate window for a covered file");
    let second = windows.iter().find(|(l, _, _)| l == "window-2").unwrap();
    assert_eq!(second.2.as_deref(), Some(canon(&file).as_str()), "argument must not be lost");
    // The other restored window kept its own project.
    let main = windows.iter().find(|(l, _, _)| l == "main").unwrap();
    assert_eq!(main.1.as_deref(), Some(canon(a.path()).as_str()));
    assert!(batch.deliveries.is_empty());
    assert_eq!(batch.raises, vec!["window-2".to_string()]);
}

#[test]
fn cold_session_plus_a_subdirectory_carries_the_reveal_in_that_windows_url() {
    let a = tempfile::tempdir().unwrap();
    let sub = a.path().join("docs");
    std::fs::create_dir(&sub).unwrap();
    let session = SessionFile {
        version: SESSION_VERSION,
        windows: vec![entry("main", &canon(a.path()), None)],
    };

    let batch = launch_batch(session, &[sub.to_str().unwrap()]);

    assert_eq!(batch.plan.len(), 1);
    assert_eq!(batch.plan[0].reveal.as_deref(), Some(canon(&sub).as_str()));
    assert_eq!(batch.plan[0].entry.folder.as_deref(), Some(canon(a.path()).as_str()));
    assert!(batch.deliveries.is_empty());
}

#[test]
fn two_file_arguments_on_a_new_folder_land_in_one_windows_url() {
    // `md a.md b.md` where an unrelated window is already open: `a.md`
    // spawns a window, and `b.md` then routes *into that spawn*. Emitting at
    // it would drop `b.md` — the window is created moments later in the same
    // block and has no listeners.
    let other = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let x = a.path().join("x.md");
    let y = a.path().join("y.md");
    std::fs::write(&x, "x").unwrap();
    std::fs::write(&y, "y").unwrap();
    let session = SessionFile {
        version: SESSION_VERSION,
        windows: vec![entry("main", &canon(other.path()), None)],
    };

    let batch = launch_batch(session, &[x.to_str().unwrap(), y.to_str().unwrap()]);

    assert_eq!(batch.plan.len(), 2, "one restored window plus one for the new folder");
    let spawned = batch.plan.iter().find(|p| p.entry.label != "main").unwrap();
    assert_eq!(spawned.entry.folder.as_deref(), Some(canon(a.path()).as_str()));
    assert_eq!(spawned.entry.path.as_deref(), Some(canon(&y).as_str()));
    assert!(batch.deliveries.is_empty());
}

#[test]
fn a_warm_open_into_a_pre_existing_window_is_still_delivered_by_event() {
    // The complement: a window that already booted DOES have listeners, and
    // must keep being told by event rather than gaining a second window.
    let a = tempfile::tempdir().unwrap();
    let file = a.path().join("notes.md");
    std::fs::write(&file, "# hi").unwrap();
    let reg = Registry::new();
    reg.upsert(entry("main", &canon(a.path()), None));

    let mut batch = Batch::default();
    route_batch(
        &mut batch,
        &reg,
        vec![file.to_str().unwrap().to_string()],
        &Origin::External,
        &|p| std::path::Path::new(p).parent().unwrap().to_string_lossy().into_owned(),
    );

    assert!(batch.plan.is_empty(), "no new window for a covered file");
    assert_eq!(
        batch.deliveries,
        vec![Delivery::OpenFile { label: "main".into(), path: canon(&file) }]
    );
}
