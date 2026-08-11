//! Routing decisions for every open request. The decisions themselves are
//! pure — everything they need arrives as an argument, so the whole routing
//! table is directly testable — except `classify`, the single point that
//! consults the filesystem (it needs `Path::is_dir` to tell a directory from
//! a file). No Tauri types.

use crate::session::store::WindowEntry;

/// Document extensions the app opens. Must stay in sync with the frontend's
/// `isSupportedExtension` and the `md` launcher script's case glob.
const SUPPORTED_EXTS: &[&str] = &["md", "markdown", "mdx", "mdown", "typ"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Directory(String),
    File(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// CLI argument, Finder, drag-onto-dock — no window asked for this.
    External,
    /// An in-app action (Switch Project, folder drag-drop) from a known window.
    InApp { requesting: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Raise `label`; optionally load a document into it and/or reveal a
    /// directory in its tree without changing its root.
    Focus { label: String, load: Option<String>, reveal: Option<String> },
    /// Take over an existing blank window.
    Adopt { label: String, folder: Option<String>, load: Option<String> },
    /// No window can serve this; make one.
    Spawn { folder: Option<String>, file: Option<String> },
}

/// Classify a path. Directories win over the extension check so a directory
/// literally named `notes.md` still opens as a project root.
pub fn classify(path: &str) -> Option<Target> {
    if std::path::Path::new(path).is_dir() {
        return Some(Target::Directory(path.to_string()));
    }
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext {
        Some(e) if SUPPORTED_EXTS.contains(&e.as_str()) => Some(Target::File(path.to_string())),
        _ => None,
    }
}

/// Split into non-empty segments so trailing and doubled separators collapse.
fn segments(p: &str) -> Vec<&str> {
    p.split('/').filter(|s| !s.is_empty()).collect()
}

/// True when `folder` is an ancestor of, or equal to, `path` — compared on
/// segment boundaries, so `/proj/docs` does not contain `/proj/docs-old/x.md`.
pub fn contains(folder: &str, path: &str) -> bool {
    let f = segments(folder);
    let p = segments(path);
    f.len() <= p.len() && f.iter().zip(p.iter()).all(|(a, b)| a == b)
}

/// The live window whose folder most specifically contains `path`.
pub fn deepest_containing<'a>(windows: &'a [WindowEntry], path: &str) -> Option<&'a WindowEntry> {
    windows
        .iter()
        .filter(|w| w.folder.as_deref().is_some_and(|f| contains(f, path)))
        .max_by_key(|w| segments(w.folder.as_deref().unwrap_or("")).len())
}

/// A window with no project, no document, and nothing unsaved — safe to adopt.
pub fn is_blank(w: &WindowEntry) -> bool {
    w.folder.is_none() && w.path.is_none() && !w.dirty
}

pub fn route_directory(dir: &str, origin: &Origin, windows: &[WindowEntry]) -> Route {
    // 1. A window is already rooted exactly here.
    if let Some(w) = windows.iter().find(|w| w.folder.as_deref() == Some(dir)) {
        return Route::Focus { label: w.label.clone(), load: None, reveal: None };
    }
    // 2. A window's tree contains it — focus and reveal, but keep its root.
    if let Some(w) = deepest_containing(windows, dir) {
        return Route::Focus {
            label: w.label.clone(),
            load: None,
            reveal: Some(dir.to_string()),
        };
    }
    // 3/4. Take over a blank window: the one that asked, or the only one open.
    if let Some(label) = adoptable(origin, windows) {
        return Route::Adopt { label, folder: Some(dir.to_string()), load: None };
    }
    // 5. Nothing can serve it.
    Route::Spawn { folder: Some(dir.to_string()), file: None }
}

/// The label of a window it is safe to take over, if any. An in-app request
/// may adopt the window that made it; an external request may adopt only when
/// there is exactly one window open — picking one blank window out of several
/// would be arbitrary from the user's point of view.
fn adoptable(origin: &Origin, windows: &[WindowEntry]) -> Option<String> {
    if let Origin::InApp { requesting } = origin {
        if let Some(w) = windows.iter().find(|w| &w.label == requesting && is_blank(w)) {
            return Some(w.label.clone());
        }
    }
    match windows {
        [only] if is_blank(only) => Some(only.label.clone()),
        _ => None,
    }
}

/// Route a document open request. See the spec's File table.
pub fn route_file(
    file: &str,
    origin: &Origin,
    windows: &[WindowEntry],
    folder_root_of: &dyn Fn(&str) -> String,
) -> Route {
    // 1. Some window already has this exact document open.
    if let Some(w) = windows.iter().find(|w| w.path.as_deref() == Some(file)) {
        return Route::Focus { label: w.label.clone(), load: None, reveal: None };
    }
    // 2. Some window's tree contains it — load it there.
    if let Some(w) = deepest_containing(windows, file) {
        return Route::Focus {
            label: w.label.clone(),
            load: Some(file.to_string()),
            reveal: None,
        };
    }
    // 3/4/5. Nothing covers it: root a window at the file's own tree. Cold
    // start and warm launch take the same branch, which is what makes them
    // produce identical windows.
    let root = folder_root_of(file);
    let folder = (!root.is_empty()).then_some(root);
    if let Some(label) = adoptable(origin, windows) {
        return Route::Adopt { label, folder, load: Some(file.to_string()) };
    }
    Route::Spawn { folder, file: Some(file.to_string()) }
}

/// The single entry point every open request goes through.
pub fn route(
    target: &Target,
    origin: &Origin,
    windows: &[WindowEntry],
    folder_root_of: &dyn Fn(&str) -> String,
) -> Route {
    match target {
        Target::Directory(d) => route_directory(d, origin, windows),
        Target::File(f) => route_file(f, origin, windows, folder_root_of),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::store::{WindowEntry, WindowMode};

    pub(super) fn win(label: &str, folder: Option<&str>, path: Option<&str>) -> WindowEntry {
        WindowEntry {
            label: label.to_string(),
            folder: folder.map(str::to_string),
            path: path.map(str::to_string),
            dirty: false,
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            scroll_top: 0.0,
            mode: WindowMode::Reading,
            sidebar_visible: None,
            timestamp_ms: 0,
        }
    }

    #[test]
    fn classify_reads_a_directory_as_a_directory_target() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_string_lossy().into_owned();
        assert_eq!(classify(&p), Some(Target::Directory(p.clone())));
    }

    #[test]
    fn classify_reads_a_supported_extension_as_a_file_target() {
        for name in ["/a/x.md", "/a/x.markdown", "/a/x.mdx", "/a/x.mdown", "/a/x.typ", "/a/X.MD"] {
            assert_eq!(classify(name), Some(Target::File(name.to_string())), "{name}");
        }
    }

    #[test]
    fn classify_ignores_an_unsupported_path() {
        assert_eq!(classify("/a/photo.png"), None);
        assert_eq!(classify("/a/no-extension"), None);
    }

    #[test]
    fn contains_matches_an_exact_folder() {
        assert!(contains("/proj/docs", "/proj/docs"));
    }

    #[test]
    fn contains_matches_a_descendant() {
        assert!(contains("/proj", "/proj/docs/x.md"));
    }

    #[test]
    fn contains_respects_segment_boundaries() {
        assert!(!contains("/proj/docs", "/proj/docs-old/x.md"));
    }

    #[test]
    fn contains_tolerates_trailing_and_doubled_separators() {
        assert!(contains("/proj/docs/", "/proj//docs/x.md"));
    }

    #[test]
    fn contains_is_false_when_the_folder_is_deeper_than_the_path() {
        assert!(!contains("/proj/docs/deep", "/proj/docs"));
    }

    #[test]
    fn deepest_containing_picks_the_most_specific_window() {
        let windows = vec![
            win("main", Some("/proj"), None),
            win("window-2", Some("/proj/docs"), None),
        ];
        let hit = deepest_containing(&windows, "/proj/docs/x.md").unwrap();
        assert_eq!(hit.label, "window-2");
    }

    #[test]
    fn deepest_containing_is_independent_of_insertion_order() {
        let windows = vec![
            win("window-2", Some("/proj/docs"), None),
            win("main", Some("/proj"), None),
        ];
        assert_eq!(deepest_containing(&windows, "/proj/docs/x.md").unwrap().label, "window-2");
    }

    #[test]
    fn deepest_containing_ignores_blank_windows() {
        let windows = vec![win("main", None, None)];
        assert!(deepest_containing(&windows, "/proj/x.md").is_none());
    }

    #[test]
    fn deepest_containing_returns_none_when_nothing_contains_the_path() {
        let windows = vec![win("main", Some("/other"), None)];
        assert!(deepest_containing(&windows, "/proj/x.md").is_none());
    }

    #[test]
    fn is_blank_requires_no_folder_no_path_and_no_unsaved_changes() {
        assert!(is_blank(&win("main", None, None)));
        assert!(!is_blank(&win("main", Some("/p"), None)));
        assert!(!is_blank(&win("main", None, Some("/p/x.md"))));
        let mut dirty = win("main", None, None);
        dirty.dirty = true;
        assert!(!is_blank(&dirty), "a scratch buffer with unsaved work is not blank");
    }

    fn focus_label(r: &Route) -> &str {
        match r {
            Route::Focus { label, .. } => label,
            other => panic!("expected Focus, got {other:?}"),
        }
    }

    #[test]
    fn dir_rule1_focuses_the_window_already_rooted_there() {
        let windows = vec![win("main", Some("/a"), None), win("window-2", Some("/proj"), None)];
        let r = route_directory("/proj", &Origin::External, &windows);
        assert_eq!(r, Route::Focus { label: "window-2".into(), load: None, reveal: None });
    }

    #[test]
    fn dir_rule1_focuses_the_requesting_window_when_it_already_owns_the_target() {
        let windows = vec![win("main", Some("/proj"), None)];
        let r = route_directory("/proj", &Origin::InApp { requesting: "main".into() }, &windows);
        assert_eq!(focus_label(&r), "main");
    }

    #[test]
    fn dir_rule2_focuses_the_containing_window_and_reveals_without_re_rooting() {
        let windows = vec![win("window-2", Some("/proj"), None)];
        let r = route_directory("/proj/docs", &Origin::External, &windows);
        assert_eq!(
            r,
            Route::Focus {
                label: "window-2".into(),
                load: None,
                reveal: Some("/proj/docs".into()),
            }
        );
    }

    #[test]
    fn dir_rule2_picks_the_deepest_containing_window() {
        let windows = vec![
            win("main", Some("/proj"), None),
            win("window-2", Some("/proj/docs"), None),
        ];
        let r = route_directory("/proj/docs/api", &Origin::External, &windows);
        assert_eq!(focus_label(&r), "window-2");
    }

    #[test]
    fn dir_rule3_adopts_the_requesting_window_when_it_is_blank() {
        let windows = vec![win("main", None, None), win("window-2", Some("/other"), None)];
        let r = route_directory("/proj", &Origin::InApp { requesting: "main".into() }, &windows);
        assert_eq!(
            r,
            Route::Adopt { label: "main".into(), folder: Some("/proj".into()), load: None }
        );
    }

    #[test]
    fn dir_rule3_does_not_adopt_a_requesting_window_that_owns_another_folder() {
        let windows = vec![win("main", Some("/other"), None)];
        let r = route_directory("/proj", &Origin::InApp { requesting: "main".into() }, &windows);
        assert_eq!(r, Route::Spawn { folder: Some("/proj".into()), file: None });
    }

    #[test]
    fn dir_rule4_adopts_the_sole_blank_window_on_an_external_request() {
        let windows = vec![win("main", None, None)];
        let r = route_directory("/proj", &Origin::External, &windows);
        assert_eq!(
            r,
            Route::Adopt { label: "main".into(), folder: Some("/proj".into()), load: None }
        );
    }

    #[test]
    fn dir_rule4_does_not_fire_when_more_than_one_window_is_open() {
        // Picking one blank window out of several is arbitrary; spawn instead.
        let windows = vec![win("main", None, None), win("window-2", None, None)];
        let r = route_directory("/proj", &Origin::External, &windows);
        assert_eq!(r, Route::Spawn { folder: Some("/proj".into()), file: None });
    }

    #[test]
    fn dir_rule4_does_not_steal_a_window_with_unsaved_work() {
        let mut only = win("main", None, None);
        only.dirty = true;
        let r = route_directory("/proj", &Origin::External, &[only]);
        assert_eq!(r, Route::Spawn { folder: Some("/proj".into()), file: None });
    }

    #[test]
    fn dir_rule5_spawns_when_no_window_is_open_at_all() {
        let r = route_directory("/proj", &Origin::External, &[]);
        assert_eq!(r, Route::Spawn { folder: Some("/proj".into()), file: None });
    }

    #[test]
    fn dir_rule5_spawns_for_an_ancestor_of_an_open_root() {
        // Accepted consequence in the spec: widening is not re-rooting, so
        // `md /proj` next to a window rooted at /proj/docs gets its own window.
        let windows = vec![win("window-2", Some("/proj/docs"), None)];
        let r = route_directory("/proj", &Origin::External, &windows);
        assert_eq!(r, Route::Spawn { folder: Some("/proj".into()), file: None });
    }

    /// Stand-in for `resolve_folder_root`: the parent directory.
    fn parent_of(p: &str) -> String {
        match p.rfind('/') {
            Some(0) | None => "/".to_string(),
            Some(i) => p[..i].to_string(),
        }
    }

    #[test]
    fn file_rule1_focuses_a_window_that_already_has_the_file_open() {
        let windows = vec![
            win("main", Some("/proj"), Some("/proj/x.md")),
            win("window-2", Some("/proj/docs"), None),
        ];
        let r = route_file("/proj/x.md", &Origin::External, &windows, &parent_of);
        assert_eq!(r, Route::Focus { label: "main".into(), load: None, reveal: None });
    }

    #[test]
    fn file_rule2_loads_the_file_into_the_containing_window() {
        let windows = vec![win("window-2", Some("/proj"), Some("/proj/other.md"))];
        let r = route_file("/proj/docs/x.md", &Origin::External, &windows, &parent_of);
        assert_eq!(
            r,
            Route::Focus {
                label: "window-2".into(),
                load: Some("/proj/docs/x.md".into()),
                reveal: None,
            }
        );
    }

    #[test]
    fn file_rule2_picks_the_deepest_containing_window() {
        let windows = vec![
            win("main", Some("/proj"), None),
            win("window-2", Some("/proj/docs"), None),
        ];
        let r = route_file("/proj/docs/x.md", &Origin::External, &windows, &parent_of);
        assert_eq!(focus_label(&r), "window-2");
    }

    #[test]
    fn file_rule2_respects_segment_boundaries() {
        let windows = vec![win("main", Some("/proj/docs"), None)];
        let r = route_file("/proj/docs-old/x.md", &Origin::External, &windows, &parent_of);
        assert_eq!(
            r,
            Route::Spawn {
                folder: Some("/proj/docs-old".into()),
                file: Some("/proj/docs-old/x.md".into()),
            }
        );
    }

    #[test]
    fn file_rule4_adopts_the_sole_blank_window_and_roots_it_at_the_files_folder() {
        // The cold-start case: `md notes.md` on an empty session must produce
        // the same window the warm path would.
        let windows = vec![win("main", None, None)];
        let r = route_file("/proj/notes.md", &Origin::External, &windows, &parent_of);
        assert_eq!(
            r,
            Route::Adopt {
                label: "main".into(),
                folder: Some("/proj".into()),
                load: Some("/proj/notes.md".into()),
            }
        );
    }

    #[test]
    fn file_rule3_adopts_the_requesting_blank_window() {
        let windows = vec![win("main", None, None), win("window-2", Some("/other"), None)];
        let r = route_file(
            "/proj/notes.md",
            &Origin::InApp { requesting: "main".into() },
            &windows,
            &parent_of,
        );
        assert_eq!(
            r,
            Route::Adopt {
                label: "main".into(),
                folder: Some("/proj".into()),
                load: Some("/proj/notes.md".into()),
            }
        );
    }

    #[test]
    fn file_rule5_spawns_rooted_at_the_files_folder() {
        let windows = vec![win("main", Some("/other"), None)];
        let r = route_file("/proj/notes.md", &Origin::External, &windows, &parent_of);
        assert_eq!(
            r,
            Route::Spawn {
                folder: Some("/proj".into()),
                file: Some("/proj/notes.md".into()),
            }
        );
    }

    #[test]
    fn file_rule5_never_spawns_a_second_window_for_an_already_covered_file() {
        // Regression guard for the duplicate-window symptom: a restored
        // session window covering the file must absorb the request.
        let windows = vec![win("main", Some("/a"), None), win("window-2", Some("/b"), None)];
        let r = route_file("/b/notes.md", &Origin::External, &windows, &parent_of);
        assert_eq!(focus_label(&r), "window-2");
    }

    #[test]
    fn route_dispatches_on_the_target_kind() {
        let windows = vec![win("main", Some("/proj"), None)];
        assert_eq!(
            route(&Target::Directory("/proj".into()), &Origin::External, &windows, &parent_of),
            Route::Focus { label: "main".into(), load: None, reveal: None }
        );
        assert_eq!(
            route(&Target::File("/proj/x.md".into()), &Origin::External, &windows, &parent_of),
            Route::Focus {
                label: "main".into(),
                load: Some("/proj/x.md".into()),
                reveal: None
            }
        );
    }
}
