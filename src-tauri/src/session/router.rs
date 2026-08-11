//! Routing decisions for every open request. The decisions themselves are
//! pure — everything they need arrives as an argument, so the whole routing
//! table is directly testable — except `classify`, the single point that
//! consults the filesystem (it needs `Path::is_dir` to tell a directory from
//! a file). No Tauri types.

use crate::session::store::WindowEntry;

/// Document extensions the app opens. Must stay in sync with the frontend's
/// `isSupportedExtension` and the `md` launcher script's case glob.
const SUPPORTED_EXTS: &[&str] = &["md", "markdown", "mdx", "mdown", "typ"];

// No consumer yet: routing tables land in Tasks 5-6.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Directory(String),
    File(String),
}

// No consumer yet: routing tables land in Tasks 5-6.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// CLI argument, Finder, drag-onto-dock — no window asked for this.
    External,
    /// An in-app action (Switch Project, folder drag-drop) from a known window.
    InApp { requesting: String },
}

// No consumer yet: routing tables land in Tasks 5-6.
#[allow(dead_code)]
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
// No consumer yet: first called from route_directory / route_file (Tasks 5-6).
#[allow(dead_code)]
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
// No consumer yet: first called from route_directory / route_file (Tasks 5-6).
#[allow(dead_code)]
pub fn contains(folder: &str, path: &str) -> bool {
    let f = segments(folder);
    let p = segments(path);
    f.len() <= p.len() && f.iter().zip(p.iter()).all(|(a, b)| a == b)
}

/// The live window whose folder most specifically contains `path`.
// No consumer yet: first called from route_directory / route_file (Tasks 5-6).
#[allow(dead_code)]
pub fn deepest_containing<'a>(windows: &'a [WindowEntry], path: &str) -> Option<&'a WindowEntry> {
    windows
        .iter()
        .filter(|w| w.folder.as_deref().is_some_and(|f| contains(f, path)))
        .max_by_key(|w| segments(w.folder.as_deref().unwrap_or("")).len())
}

/// A window with no project, no document, and nothing unsaved — safe to adopt.
// No consumer yet: first called from route_directory / route_file (Tasks 5-6).
#[allow(dead_code)]
pub fn is_blank(w: &WindowEntry) -> bool {
    w.folder.is_none() && w.path.is_none() && !w.dirty
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
}
