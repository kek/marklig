//! The cold-start restore decision, kept pure so it is testable without an
//! app handle: existence checks arrive as a closure and the caller performs
//! the actual window creation.

use std::collections::HashSet;

use crate::commands::files::RecoveryEntry;
use crate::session::store::{SessionFile, WindowEntry};

/// One window the launch should create, plus the crash dump it should load.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedWindow {
    pub entry: WindowEntry,
    /// `original_path` of the recovery dump this window owns, if any.
    pub dump: Option<String>,
}

/// Decide what to create at launch.
///
/// Never returns an empty plan: a corrupt session, a vanished project, or an
/// unreadable app-data dir all end at one blank welcome window rather than a
/// window-less app. Removing the declarative window from `tauri.conf.json`
/// makes this the only guard.
pub fn restore_plan(
    session: SessionFile,
    dumps: Vec<RecoveryEntry>,
    exists: &dyn Fn(&str) -> bool,
) -> Vec<PlannedWindow> {
    let mut entries = dedupe_by_folder(session.windows);
    entries.retain_mut(|e| reconcile_with_disk(e, exists));

    let mut used: HashSet<String> = entries.iter().map(|e| e.label.clone()).collect();
    let mut plan: Vec<PlannedWindow> =
        entries.into_iter().map(|entry| PlannedWindow { entry, dump: None }).collect();

    // Pair each dump with the window that owns its file; anything left over
    // is content with nowhere to land, so it gets a window of its own.
    for d in dumps {
        match plan.iter_mut().find(|p| p.entry.path.as_deref() == Some(d.original_path.as_str())) {
            Some(p) => p.dump = Some(d.original_path),
            None => {
                let label = fresh_label(&mut used);
                plan.push(PlannedWindow {
                    entry: WindowEntry {
                        path: Some(d.original_path.clone()),
                        ..blank_entry(label)
                    },
                    dump: Some(d.original_path),
                });
            }
        }
    }

    if plan.is_empty() {
        let label = fresh_label(&mut used);
        plan.push(PlannedWindow { entry: blank_entry(label), dump: None });
    }
    plan
}

/// Keep the newest entry per folder. Blank windows have no folder identity and
/// are never deduped against each other. Live routing already guarantees one
/// window per folder; this is the safety net for a stale or hand-edited file.
fn dedupe_by_folder(entries: Vec<WindowEntry>) -> Vec<WindowEntry> {
    let mut best: Vec<usize> = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        let Some(folder) = e.folder.as_deref() else {
            best.push(i);
            continue;
        };
        match best
            .iter()
            .position(|&j| entries[j].folder.as_deref() == Some(folder))
        {
            Some(pos) if entries[best[pos]].timestamp_ms < e.timestamp_ms => best[pos] = i,
            Some(_) => {}
            None => best.push(i),
        }
    }
    let keep: HashSet<usize> = best.into_iter().collect();
    entries
        .into_iter()
        .enumerate()
        .filter_map(|(i, e)| keep.contains(&i).then_some(e))
        .collect()
}

/// Reconcile one entry against the filesystem. Returns false when the entry
/// should be dropped entirely. No modal, no prompt — a launch must not stop to
/// ask about a project that moved (see #122).
fn reconcile_with_disk(e: &mut WindowEntry, exists: &dyn Fn(&str) -> bool) -> bool {
    // Whether this window was anchored to anything at all when it was recorded.
    let had_anchor = e.folder.is_some() || e.path.is_some();
    if let Some(folder) = e.folder.clone() {
        if !exists(&folder) {
            e.folder = None;
        }
    }
    if let Some(path) = e.path.clone() {
        if !exists(&path) {
            e.path = None;
        }
    }
    // A window that was blank at quit time is restored blank — it was open, so
    // it comes back. Only drop an entry whose anchors have VANISHED from disk;
    // the user would otherwise get a blank window where their project used to be.
    !had_anchor || e.folder.is_some() || e.path.is_some()
}

fn blank_entry(label: String) -> WindowEntry {
    WindowEntry {
        label,
        folder: None,
        path: None,
        dirty: false,
        x: 0,
        y: 0,
        width: 1000,
        height: 760,
        scroll_top: 0.0,
        mode: crate::session::store::WindowMode::Reading,
        sidebar_visible: None,
        timestamp_ms: 0,
    }
}

fn fresh_label(used: &mut HashSet<String>) -> String {
    let mut n = 1;
    loop {
        let label = if n == 1 { "main".to_string() } else { format!("window-{n}") };
        if used.insert(label.clone()) {
            return label;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::store::{WindowEntry, WindowMode, SESSION_VERSION};

    fn entry(label: &str, folder: Option<&str>, path: Option<&str>, ts: i64) -> WindowEntry {
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
            timestamp_ms: ts,
        }
    }

    fn session(windows: Vec<WindowEntry>) -> SessionFile {
        SessionFile { version: SESSION_VERSION, windows }
    }

    fn dump(path: &str) -> RecoveryEntry {
        RecoveryEntry {
            original_path: path.to_string(),
            contents: "unsaved".into(),
            timestamp_ms: 1,
        }
    }

    /// Everything exists.
    fn all(_: &str) -> bool {
        true
    }

    #[test]
    fn an_empty_session_plans_exactly_one_blank_welcome_window() {
        let plan = restore_plan(session(vec![]), vec![], &all);
        assert_eq!(plan.len(), 1);
        assert!(plan[0].entry.folder.is_none());
        assert!(plan[0].entry.path.is_none());
        assert!(plan[0].dump.is_none());
    }

    #[test]
    fn a_two_window_session_plans_exactly_two_windows() {
        let plan = restore_plan(
            session(vec![entry("main", Some("/a"), None, 1), entry("window-2", Some("/b"), None, 1)]),
            vec![],
            &all,
        );
        let folders: Vec<Option<String>> = plan.iter().map(|p| p.entry.folder.clone()).collect();
        assert_eq!(folders, vec![Some("/a".into()), Some("/b".into())]);
    }

    #[test]
    fn two_entries_on_one_folder_collapse_to_the_newest() {
        let plan = restore_plan(
            session(vec![
                entry("main", Some("/a"), Some("/a/old.md"), 1),
                entry("window-2", Some("/a"), Some("/a/new.md"), 9),
            ]),
            vec![],
            &all,
        );
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].entry.path.as_deref(), Some("/a/new.md"));
    }

    #[test]
    fn blank_entries_are_never_deduped_against_each_other() {
        let plan = restore_plan(
            session(vec![entry("main", None, None, 1), entry("window-2", None, None, 2)]),
            vec![],
            &all,
        );
        assert_eq!(plan.len(), 2);
    }

    #[test]
    fn a_missing_folder_falls_back_to_the_recorded_file() {
        let plan = restore_plan(
            session(vec![entry("main", Some("/gone"), Some("/kept/x.md"), 1)]),
            vec![],
            &|p| p != "/gone",
        );
        assert_eq!(plan.len(), 1);
        assert!(plan[0].entry.folder.is_none());
        assert_eq!(plan[0].entry.path.as_deref(), Some("/kept/x.md"));
    }

    #[test]
    fn an_entry_with_both_folder_and_file_gone_is_dropped() {
        let plan = restore_plan(
            session(vec![
                entry("main", Some("/gone"), Some("/gone/x.md"), 1),
                entry("window-2", Some("/kept"), None, 1),
            ]),
            vec![],
            &|p| p.starts_with("/kept"),
        );
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].entry.folder.as_deref(), Some("/kept"));
    }

    #[test]
    fn a_missing_file_keeps_the_window_and_clears_the_path() {
        // The frontend's per-project fallback chain picks the next document.
        let plan = restore_plan(
            session(vec![entry("main", Some("/kept"), Some("/kept/gone.md"), 1)]),
            vec![],
            &|p| p == "/kept",
        );
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].entry.folder.as_deref(), Some("/kept"));
        assert!(plan[0].entry.path.is_none());
    }

    #[test]
    fn dropping_every_entry_still_plans_one_welcome_window() {
        let plan = restore_plan(
            session(vec![entry("main", Some("/gone"), Some("/gone/x.md"), 1)]),
            vec![],
            &|_| false,
        );
        assert_eq!(plan.len(), 1);
        assert!(plan[0].entry.folder.is_none());
    }

    #[test]
    fn a_dump_is_paired_with_the_window_that_owns_its_file() {
        let plan = restore_plan(
            session(vec![
                entry("main", Some("/a"), Some("/a/x.md"), 1),
                entry("window-2", Some("/b"), Some("/b/y.md"), 1),
            ]),
            vec![dump("/a/x.md")],
            &all,
        );
        let main = plan.iter().find(|p| p.entry.label == "main").unwrap();
        let second = plan.iter().find(|p| p.entry.label == "window-2").unwrap();
        assert_eq!(main.dump.as_deref(), Some("/a/x.md"));
        assert!(second.dump.is_none());
    }

    #[test]
    fn an_unclaimed_dump_gets_its_own_window_with_a_fresh_label() {
        let plan = restore_plan(
            session(vec![entry("main", Some("/a"), Some("/a/x.md"), 1)]),
            vec![dump("/a/x.md"), dump("/z/orphan.md")],
            &all,
        );
        assert_eq!(plan.len(), 2);
        let orphan = plan.iter().find(|p| p.dump.as_deref() == Some("/z/orphan.md")).unwrap();
        assert_eq!(orphan.entry.path.as_deref(), Some("/z/orphan.md"));
        assert_ne!(orphan.entry.label, "main", "must not collide with a restored label");
    }

    #[test]
    fn an_unclaimed_dump_survives_a_file_that_no_longer_exists_on_disk() {
        // The dump IS the content; a deleted original must not lose it.
        let plan = restore_plan(session(vec![]), vec![dump("/z/orphan.md")], &|_| false);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].dump.as_deref(), Some("/z/orphan.md"));
    }

    #[test]
    fn labels_in_a_plan_are_unique() {
        let plan = restore_plan(
            session(vec![entry("main", Some("/a"), None, 1), entry("window-2", Some("/b"), None, 1)]),
            vec![dump("/p.md"), dump("/q.md")],
            &all,
        );
        let mut labels: Vec<String> = plan.iter().map(|p| p.entry.label.clone()).collect();
        labels.sort();
        let count = labels.len();
        labels.dedup();
        assert_eq!(labels.len(), count);
    }
}
