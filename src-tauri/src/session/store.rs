//! On-disk session format. Single writer: only `registry.rs` calls
//! `write_session`, so there is no load-modify-save race to defend against.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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

/// Legacy geometry record, stored under `viewer.window.<label>`.
#[derive(Deserialize)]
struct LegacyGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// One-shot migration off the `tauri-plugin-store` keys written by the old
/// TypeScript session code. Returns None when there is nothing to migrate —
/// including a store that exists but holds no `windowSession:` keys, so a
/// fresh install is never mistaken for "an empty session was migrated".
///
/// `tauri-plugin-store` has resolved `viewer.store.json` under the app data
/// dir in some versions and the app config dir in others; check both rather
/// than pinning a version-specific location.
// No consumer yet: first called from lib.rs setup (Task 9).
#[allow(dead_code)]
pub fn migrate_from_plugin_store(app_data: &Path, config_dir: &Path) -> Option<SessionFile> {
    let raw = [app_data, config_dir]
        .iter()
        .map(|d| d.join("viewer.store.json"))
        .find_map(|p| std::fs::read(p).ok())?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(&raw).ok()?;

    let mut windows: Vec<WindowEntry> = map
        .iter()
        .filter(|(k, _)| k.starts_with("windowSession:"))
        .filter_map(|(_, v)| serde_json::from_value::<WindowEntry>(v.clone()).ok())
        .collect();
    if windows.is_empty() {
        return None;
    }

    // The dedicated geometry key was authoritative; the session entry's copy
    // could lag by one tick. Prefer it where present.
    for w in &mut windows {
        if let Some(g) = map
            .get(&format!("viewer.window.{}", w.label))
            .and_then(|v| serde_json::from_value::<LegacyGeometry>(v.clone()).ok())
        {
            w.x = g.x;
            w.y = g.y;
            w.width = g.width;
            w.height = g.height;
        }
        // A migrated buffer is never assumed dirty: the crash-recovery store
        // is what carries unsaved content across a restart.
        w.dirty = false;
    }
    windows.sort_by(|a, b| a.label.cmp(&b.label));
    Some(SessionFile { version: SESSION_VERSION, windows })
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

    fn write_plugin_store(dir: &Path, json: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("viewer.store.json"), json).unwrap();
    }

    #[test]
    fn migrates_per_window_keys_into_a_session_file() {
        let data = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        write_plugin_store(
            data.path(),
            r#"{
              "windowSession:main": {"label":"main","path":"/proj/a.md","folder":"/proj",
                "x":1,"y":2,"width":900,"height":700,"scrollTop":40,"mode":"edit","timestampMs":7},
              "windowSession:window-2": {"label":"window-2","path":null,"folder":null,
                "x":3,"y":4,"width":800,"height":600,"scrollTop":0,"mode":"reading","timestampMs":9},
              "recents": ["/proj/a.md"]
            }"#,
        );
        let migrated = migrate_from_plugin_store(data.path(), config.path()).unwrap();
        assert_eq!(migrated.version, SESSION_VERSION);
        assert_eq!(migrated.windows.len(), 2);
        let main = migrated.windows.iter().find(|w| w.label == "main").unwrap();
        assert_eq!(main.folder.as_deref(), Some("/proj"));
        assert_eq!(main.path.as_deref(), Some("/proj/a.md"));
        assert_eq!(main.mode, WindowMode::Edit);
        assert_eq!(main.scroll_top, 40.0);
        assert!(!main.dirty, "a migrated entry is never assumed dirty");
    }

    #[test]
    fn migration_prefers_geometry_from_the_legacy_window_key() {
        // viewer.window.<label> was the authoritative geometry record; the
        // session entry's copy could be up to one tick staler.
        let data = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        write_plugin_store(
            data.path(),
            r#"{
              "windowSession:main": {"label":"main","path":null,"folder":null,
                "x":1,"y":1,"width":100,"height":100,"scrollTop":0,"mode":"reading","timestampMs":1},
              "viewer.window.main": {"x":50,"y":60,"width":1200,"height":900}
            }"#,
        );
        let m = migrate_from_plugin_store(data.path(), config.path()).unwrap();
        let main = &m.windows[0];
        assert_eq!((main.x, main.y, main.width, main.height), (50, 60, 1200, 900));
    }

    #[test]
    fn migration_reads_the_config_dir_when_the_data_dir_has_no_store() {
        let data = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        write_plugin_store(
            config.path(),
            r#"{"windowSession:main":{"label":"main","path":null,"folder":"/p",
               "x":0,"y":0,"width":800,"height":600,"scrollTop":0,"mode":"reading","timestampMs":1}}"#,
        );
        let m = migrate_from_plugin_store(data.path(), config.path()).unwrap();
        assert_eq!(m.windows[0].folder.as_deref(), Some("/p"));
    }

    #[test]
    fn migration_returns_none_when_there_is_nothing_to_migrate() {
        let data = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        assert!(migrate_from_plugin_store(data.path(), config.path()).is_none());

        write_plugin_store(data.path(), r#"{"recents":["/a.md"]}"#);
        assert!(
            migrate_from_plugin_store(data.path(), config.path()).is_none(),
            "a store with no windowSession keys must not migrate an empty session"
        );
    }

    #[test]
    fn migration_skips_malformed_entries_but_keeps_the_rest() {
        let data = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        write_plugin_store(
            data.path(),
            r#"{
              "windowSession:bad": 42,
              "windowSession:main": {"label":"main","path":null,"folder":null,
                "x":0,"y":0,"width":800,"height":600,"scrollTop":0,"mode":"reading","timestampMs":1}
            }"#,
        );
        let m = migrate_from_plugin_store(data.path(), config.path()).unwrap();
        assert_eq!(m.windows.len(), 1);
        assert_eq!(m.windows[0].label, "main");
    }
}
