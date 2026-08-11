//! On-disk session format. Single writer: only `registry.rs` calls
//! `write_session`, so there is no load-modify-save race to defend against.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// No consumer yet: first read by registry.rs (Task 3).
#[allow(dead_code)]
pub const SESSION_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowMode {
    #[default]
    Reading,
    Edit,
}

impl WindowMode {
    // No consumer yet: first called from window_url (Task 8).
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            WindowMode::Reading => "reading",
            WindowMode::Edit => "edit",
        }
    }
}

/// One window's state. This is both the persisted record and the live
/// registry value — there is deliberately only one type, so the routing map
/// and the session file can never disagree.
// No consumer yet: first constructed by registry.rs (Task 3).
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowEntry {
    pub label: String,
    /// Canonical sidebar root, or None for a window with no project open.
    #[serde(default)]
    pub folder: Option<String>,
    /// Canonical path of the open document, or None for a blank buffer.
    #[serde(default)]
    pub path: Option<String>,
    /// Unsaved changes present. Guards the "adopt a blank window" rules.
    #[serde(default)]
    pub dirty: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub scroll_top: f64,
    #[serde(default)]
    pub mode: WindowMode,
    #[serde(default)]
    pub sidebar_visible: Option<bool>,
    pub timestamp_ms: i64,
}

// No consumer yet: first constructed by registry.rs (Task 3).
#[allow(dead_code)]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub windows: Vec<WindowEntry>,
}

// No consumer yet: first called from lib.rs setup (Task 9).
#[allow(dead_code)]
pub fn session_path(app_data: &Path) -> PathBuf {
    app_data.join("session.json")
}

/// Read the session. Any failure — missing, unreadable, corrupt, wrong shape —
/// yields an empty session. A launch must never be blocked by a bad file.
// No consumer yet: first called from session/mod.rs run_launch (Task 8).
#[allow(dead_code)]
pub fn read_session(app_data: &Path) -> SessionFile {
    let bytes = match std::fs::read(session_path(app_data)) {
        Ok(b) => b,
        Err(_) => return SessionFile::default(),
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Write the session atomically: serialize to a sibling temp file, then
/// rename over the target. A crash mid-write leaves the previous file intact
/// rather than a truncated one that would read as an empty session.
// No consumer yet: first called from registry.rs (Task 3).
#[allow(dead_code)]
pub fn write_session(app_data: &Path, session: &SessionFile) -> std::io::Result<()> {
    std::fs::create_dir_all(app_data)?;
    let target = session_path(app_data);
    let tmp = app_data.join("session.json.tmp");
    let json = serde_json::to_vec_pretty(session)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(label: &str, folder: Option<&str>, ts: i64) -> WindowEntry {
        WindowEntry {
            label: label.to_string(),
            folder: folder.map(str::to_string),
            path: None,
            dirty: false,
            x: 10,
            y: 20,
            width: 1000,
            height: 760,
            scroll_top: 0.0,
            mode: WindowMode::Reading,
            sidebar_visible: None,
            timestamp_ms: ts,
        }
    }

    #[test]
    fn round_trips_a_session_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let session = SessionFile {
            version: SESSION_VERSION,
            windows: vec![entry("main", Some("/proj"), 1), entry("window-2", None, 2)],
        };
        write_session(dir.path(), &session).unwrap();
        assert_eq!(read_session(dir.path()), session);
    }

    #[test]
    fn missing_file_reads_as_an_empty_session() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_session(dir.path()).windows, Vec::new());
    }

    #[test]
    fn corrupt_file_reads_as_an_empty_session() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(session_path(dir.path()), b"{ not json").unwrap();
        assert_eq!(read_session(dir.path()).windows, Vec::new());
    }

    #[test]
    fn write_is_atomic_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        write_session(dir.path(), &SessionFile::default()).unwrap();
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["session.json".to_string()]);
    }

    #[test]
    fn a_partial_entry_does_not_poison_the_whole_file() {
        // An entry written by an older build without `dirty` must still load.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            session_path(dir.path()),
            br#"{"version":1,"windows":[{"label":"main","x":0,"y":0,"width":800,"height":600,"timestampMs":5}]}"#,
        )
        .unwrap();
        let s = read_session(dir.path());
        assert_eq!(s.windows.len(), 1);
        assert!(!s.windows[0].dirty);
        assert_eq!(s.windows[0].mode, WindowMode::Reading);
    }

    #[test]
    fn creates_the_app_data_directory_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("does/not/exist");
        write_session(&nested, &SessionFile::default()).unwrap();
        assert!(session_path(&nested).exists());
    }
}
