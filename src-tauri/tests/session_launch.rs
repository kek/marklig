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

/// Run a full launch: plan, seed the registry, route each argument, and
/// return the resulting window set as (label, folder) pairs plus the routes
/// that were taken.
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
