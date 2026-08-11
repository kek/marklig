//! The live window registry. Doubles as the thing we serialize, so the
//! routing map and the session file can never drift apart.
//!
//! Interior mutability via `parking_lot::Mutex` (already a dependency) so the
//! registry can live in Tauri managed state and be updated from command
//! handlers without threading `&mut` through the event loop.

use std::collections::BTreeMap;
use std::path::Path;

use parking_lot::Mutex;

use crate::session::store::{write_session, SessionFile, WindowEntry, SESSION_VERSION};

// No consumer yet: first wired into Tauri managed state as `SessionState`
// (Task 8).
#[allow(dead_code)]
pub struct Registry {
    windows: Mutex<BTreeMap<String, WindowEntry>>,
    /// Monotonic label counter. Never decremented on `forget`: reusing a
    /// label while a window with that label may still be booting is how you
    /// get two windows fighting over one registry slot.
    next_seq: Mutex<u32>,
}

// No consumer yet: first called from Tauri command handlers via
// `SessionState` (Task 8).
#[allow(dead_code)]
impl Registry {
    pub fn new() -> Self {
        Self { windows: Mutex::new(BTreeMap::new()), next_seq: Mutex::new(2) }
    }

    pub fn from_session(session: SessionFile) -> Self {
        let reg = Self::new();
        for entry in session.windows {
            reg.upsert(entry);
        }
        reg
    }

    pub fn upsert(&self, entry: WindowEntry) {
        if let Some(n) = entry.label.strip_prefix("window-").and_then(|s| s.parse::<u32>().ok()) {
            let mut seq = self.next_seq.lock();
            if n >= *seq {
                *seq = n + 1;
            }
        }
        self.windows.lock().insert(entry.label.clone(), entry);
    }

    pub fn forget(&self, label: &str) {
        self.windows.lock().remove(label);
    }

    pub fn get(&self, label: &str) -> Option<WindowEntry> {
        self.windows.lock().get(label).cloned()
    }

    pub fn contains(&self, label: &str) -> bool {
        self.windows.lock().contains_key(label)
    }

    /// Snapshot, in stable label order. Routing operates on this snapshot so
    /// the lock is never held across a Tauri call.
    pub fn entries(&self) -> Vec<WindowEntry> {
        self.windows.lock().values().cloned().collect()
    }

    /// Allocate the next free `window-N` label and reserve it.
    pub fn next_label(&self) -> String {
        let mut seq = self.next_seq.lock();
        loop {
            let label = format!("window-{}", *seq);
            *seq += 1;
            if !self.windows.lock().contains_key(&label) {
                return label;
            }
        }
    }

    pub fn to_session(&self) -> SessionFile {
        SessionFile { version: SESSION_VERSION, windows: self.entries() }
    }

    pub fn persist(&self, app_data: &Path) -> std::io::Result<()> {
        write_session(app_data, &self.to_session())
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::store::WindowMode;

    fn entry(label: &str, folder: Option<&str>, ts: i64) -> WindowEntry {
        WindowEntry {
            label: label.to_string(),
            folder: folder.map(str::to_string),
            path: None,
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

    #[test]
    fn upsert_replaces_by_label_rather_than_appending() {
        let reg = Registry::new();
        reg.upsert(entry("main", Some("/a"), 1));
        reg.upsert(entry("main", Some("/b"), 2));
        assert_eq!(reg.entries().len(), 1);
        assert_eq!(reg.get("main").unwrap().folder.as_deref(), Some("/b"));
    }

    #[test]
    fn forget_removes_only_the_named_window() {
        let reg = Registry::new();
        reg.upsert(entry("main", Some("/a"), 1));
        reg.upsert(entry("window-2", Some("/b"), 1));
        reg.forget("main");
        let labels: Vec<String> = reg.entries().into_iter().map(|e| e.label).collect();
        assert_eq!(labels, vec!["window-2".to_string()]);
    }

    #[test]
    fn entries_are_returned_in_stable_label_order() {
        let reg = Registry::new();
        reg.upsert(entry("window-3", None, 1));
        reg.upsert(entry("main", None, 1));
        reg.upsert(entry("window-2", None, 1));
        let labels: Vec<String> = reg.entries().into_iter().map(|e| e.label).collect();
        assert_eq!(labels, vec!["main".to_string(), "window-2".to_string(), "window-3".to_string()]);
    }

    #[test]
    fn next_label_skips_labels_already_in_use() {
        let reg = Registry::new();
        reg.upsert(entry("main", None, 1));
        reg.upsert(entry("window-2", None, 1));
        assert_eq!(reg.next_label(), "window-3");
        reg.upsert(entry("window-3", None, 1));
        assert_eq!(reg.next_label(), "window-4");
    }

    #[test]
    fn next_label_is_monotonic_across_a_forget() {
        // A label must not be reused while a restored window with that label
        // may still be booting.
        let reg = Registry::new();
        reg.upsert(entry("main", None, 1));
        assert_eq!(reg.next_label(), "window-2");
        reg.upsert(entry("window-2", None, 1));
        reg.forget("window-2");
        assert_eq!(reg.next_label(), "window-3");
    }

    #[test]
    fn from_session_seeds_the_registry() {
        let reg = Registry::from_session(SessionFile {
            version: SESSION_VERSION,
            windows: vec![entry("main", Some("/a"), 1)],
        });
        assert!(reg.contains("main"));
        assert_eq!(reg.next_label(), "window-2");
    }

    #[test]
    fn to_session_stamps_the_current_version() {
        let reg = Registry::new();
        reg.upsert(entry("main", None, 1));
        let s = reg.to_session();
        assert_eq!(s.version, SESSION_VERSION);
        assert_eq!(s.windows.len(), 1);
    }

    #[test]
    fn persist_writes_a_readable_session_file() {
        let dir = tempfile::tempdir().unwrap();
        let reg = Registry::new();
        reg.upsert(entry("main", Some("/a"), 1));
        reg.persist(dir.path()).unwrap();
        let back = crate::session::store::read_session(dir.path());
        assert_eq!(back.windows.len(), 1);
        assert_eq!(back.windows[0].folder.as_deref(), Some("/a"));
    }
}
