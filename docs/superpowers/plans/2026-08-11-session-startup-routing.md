# Session, Startup, and Open-Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move window-session persistence and all open-request routing from the `main` window's TypeScript into Rust, so that `md <dir>` / `md <file>` and cold start behave identically and never produce duplicate windows.

**Architecture:** A new `src-tauri/src/session/` module owns one registry of live windows, which doubles as the serialized session (`<app_data>/session.json`). A pure `router.rs` maps an open request to `Focus | Adopt | Spawn`. `launch.rs` runs at `RunEvent::Ready` — after `RunEvent::Opened` has delivered any launch arguments — restoring windows first and routing arguments second. The declarative window leaves `tauri.conf.json`, so `main` stops being a privileged label.

**Tech Stack:** Rust (Tauri 2, serde, serde_json, tempfile for tests), TypeScript (Vitest), Playwright.

## Global Constraints

- This repo is a **Jujutsu** repo. Commit with `jj desc -m "..."` then `jj new`. Never run `git commit`, `git add`, or `git checkout`.
- Commit messages: plain imperative subject, sentence case, no full stop, **no conventional-commit prefixes** (`feat:`, `fix:`, `refactor:` are forbidden).
- Run Rust commands **from the repo root** with `--workspace`. `cargo test --workspace --no-fail-fast` and `cargo clippy --workspace --all-targets --no-deps -- -D warnings` are the CI gates.
- Frontend gates: `npx tsc -b --noEmit` and `npm test`.
- All new Tauri commands and all `session` module wiring are `#[cfg(desktop)]`. Android has no fs watcher and no NSDocumentController; do not expose these to mobile.
- Path identity always goes through `commands::files::canonicalize_path_str`. Never compare folder roots with raw `starts_with`.
- User-visible strings go through `t(key)` in `src/i18n/strings.ts`. Do not hardcode UI text.
- New keyboard shortcuts must avoid `\` `[` `]` `/` (Swedish keyboard is a first-class target). This plan adds none.
- The spec is `docs/superpowers/specs/2026-08-11-session-startup-routing-design.md`. Read it before Task 1.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src-tauri/src/session/mod.rs` | Module root; re-exports; the Tauri-facing effect executor and commands |
| `src-tauri/src/session/store.rs` | `session.json` serde types, atomic read/write, plugin-store migration |
| `src-tauri/src/session/registry.rs` | `HashMap<label, WindowEntry>` of live windows; persistence trigger |
| `src-tauri/src/session/router.rs` | Pure routing decision. No Tauri types, no I/O |
| `src-tauri/src/session/launch.rs` | Cold-start restore plan: dedupe, dump pairing, welcome fallback |
| `src-tauri/tests/session_launch.rs` | Integration test over plan + route against a temp `app_data` |
| `src/shell/session-client.ts` | Frontend half: report state, forget window, request open |

**Modified:**

| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | Launch at `Ready`; buffer `Opened`; register session commands; drop `take_pending_open_paths` from the desktop chain |
| `src-tauri/tauri.conf.json` | Remove `app.windows[]` |
| `src-tauri/src/commands/mod.rs` | No change needed (session is a top-level module) |
| `src/main.ts` | `resolveInitial` reads URL params only; delete `folderByLabel`, `routeToFolder`, the announce handshake, `waitForOpenRequest`, `firstMarkdownArg`, `takePendingOpenPaths` |
| `src/shell/window-session.ts` | Reduced to nothing; deleted (its reporter role moves to `session-client.ts`) |
| `src/shell/window-state.ts` | Deleted; geometry folds into the session report |
| `src/shell/project-routing.ts` | Deleted; logic ported to `router.rs` |
| `src/shell/close.ts` | Calls `forgetWindow` instead of `removeWindowSessionEntry` |
| `src/ui/sidebar/folder.ts` | Add `revealDirectory(absolutePath)` to `FolderSidebarHandle` |

**Deleted tests:** `tests/shell/project-routing.test.ts` and `tests/shell/window-session.test.ts` — their cases are ported to Rust in Tasks 4–7.

---

### Task 0: Point the e2e specs at an explicit `?file=`

**Files:**
- Modify: every `tests/e2e/*.spec.ts` containing a bare `page.goto(APP_URL)`
- Test: `npm run test:e2e`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This task only changes tests.

**Why this comes first.** The e2e suite does not launch Tauri — it runs the app in plain Chromium against the Vite dev server with a stubbed `__TAURI_INTERNALS__` (see the `installTauriStub` helper each spec defines). Roughly 18 `page.goto(APP_URL)` sites navigate with no query string and rely on `resolveInitial`'s fallback chain — `plugin:dialog|open` returning `/virtual/sample.md` — to get a document on screen. Task 11 deletes that chain, so those specs would boot into a blank welcome buffer. CI runs `npm run test:e2e` (`.github/workflows/ci.yml:47`).

Doing this first keeps the suite green the whole way through: `resolveInitial` already honours `?file=` before any other branch (`src/main.ts:2012`), so the migrated specs pass identically on today's code and on the post-Task-11 code.

- [ ] **Step 1: Confirm the suite is green before touching it**

Run: `npm run test:e2e`
Expected: PASS. If anything is already red, stop and report — this task must not be used to mask a pre-existing failure.

- [ ] **Step 2: Migrate every bare navigation**

For each `page.goto(APP_URL)` in `tests/e2e/*.spec.ts`, pass the same path the spec's stub already serves. The stub's `read_text_file` returns the spec's `sample` regardless of path, and `plugin:dialog|open` returns `/virtual/sample.md`, so that is the path to make explicit:

```ts
await page.goto(`${APP_URL}/?file=${encodeURIComponent("/virtual/sample.md")}`);
```

`tests/e2e/cross-window-change.spec.ts:149` already does this with its own `file` variable — follow that shape. Where a spec uses a different virtual path in its stub (check each spec's `installTauriStub` call and its `plugin:dialog|open` return), use that spec's path, not `/virtual/sample.md` blindly.

Do **not** change any spec's assertions, stub, or fixtures. This is a navigation change only.

- [ ] **Step 3: Verify**

Run: `npm run test:e2e`
Expected: PASS, same test count as Step 1.

If a spec fails because it asserted on the open-dialog path itself (i.e. it was testing the fallback chain rather than using it), report that spec by name instead of rewriting its intent — that behaviour is being deleted, and the plan should decide what replaces it rather than the implementer.

- [ ] **Step 4: Commit**

```bash
jj desc -m "Navigate e2e specs to an explicit file parameter"
jj new
```

---

### Task 1: Session file format and atomic persistence

**Files:**
- Create: `src-tauri/src/session/mod.rs`
- Create: `src-tauri/src/session/store.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod session;`)
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/session/store.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `session::store::{WindowEntry, WindowMode, SessionFile, SESSION_VERSION, read_session, write_session, session_path}`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/session/store.rs` with only the test module plus the `use super::*;` line, then add the impl in Step 3.

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --workspace --no-fail-fast session::store`
Expected: FAIL — compile error, `WindowEntry` / `read_session` not found.

- [ ] **Step 3: Write minimal implementation**

Put this **above** the test module in `src-tauri/src/session/store.rs`:

```rust
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

pub fn session_path(app_data: &Path) -> PathBuf {
    app_data.join("session.json")
}

/// Read the session. Any failure — missing, unreadable, corrupt, wrong shape —
/// yields an empty session. A launch must never be blocked by a bad file.
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
```

Create `src-tauri/src/session/mod.rs`:

```rust
//! Window session state, launch restore, and open-request routing.
//!
//! Desktop-only: mobile has a single webview and no window management.

pub mod launch;
pub mod registry;
pub mod router;
pub mod store;
```

For this task only, `mod.rs` should contain just `pub mod store;` — add the other lines as those files appear in Tasks 3, 4, and 7.

In `src-tauri/src/lib.rs`, next to the other `#[cfg(desktop)]` module declarations (near `mod pairing;`), add:

```rust
#[cfg(desktop)]
mod session;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --workspace --no-fail-fast session::store`
Expected: PASS, 6 tests.

Run: `cargo clippy --workspace --all-targets --no-deps -- -D warnings`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add session.json format with atomic writes"
jj new
```

---

### Task 2: Migrate from the plugin-store keys

**Files:**
- Modify: `src-tauri/src/session/store.rs`
- Test: inline test module in `src-tauri/src/session/store.rs`

**Interfaces:**
- Consumes: `WindowEntry`, `SessionFile`, `SESSION_VERSION`, `session_path`, `write_session` from Task 1.
- Produces: `session::store::migrate_from_plugin_store(app_data: &Path, config_dir: &Path) -> Option<SessionFile>`.

Background: the frontend store is `viewer.store.json` (`src/shell/store.ts`), holding `windowSession:<label>` entries (camelCase JSON matching the old `WindowSessionEntry`) and `viewer.window.<label>` geometry records. `tauri-plugin-store` may resolve that filename under either the app data dir or the app config dir depending on version, so the migration checks both.

- [ ] **Step 1: Write the failing test**

Append to the existing `mod tests` in `src-tauri/src/session/store.rs`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --workspace --no-fail-fast session::store`
Expected: FAIL — `migrate_from_plugin_store` not found.

- [ ] **Step 3: Write minimal implementation**

Add to `src-tauri/src/session/store.rs`, above the test module:

```rust
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
```

Note: `WindowEntry`'s `#[serde(rename_all = "camelCase")]` already matches the legacy `scrollTop` / `timestampMs` / `sidebarVisible` spellings, and its `#[serde(default)]` fields absorb the missing `dirty`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --workspace --no-fail-fast session::store`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Migrate window session state off the plugin store"
jj new
```

---

### Task 3: Live window registry

**Files:**
- Create: `src-tauri/src/session/registry.rs`
- Modify: `src-tauri/src/session/mod.rs` (add `pub mod registry;`)
- Test: inline test module in `src-tauri/src/session/registry.rs`

**Interfaces:**
- Consumes: `store::{WindowEntry, SessionFile, SESSION_VERSION, write_session}`.
- Produces: `session::registry::Registry` with `new`, `from_session`, `upsert`, `forget`, `get`, `entries`, `contains`, `next_label`, `to_session`, `persist`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/session/registry.rs` containing only this test module, then add the impl in Step 3.

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --workspace --no-fail-fast session::registry`
Expected: FAIL — `Registry` not found.

- [ ] **Step 3: Write minimal implementation**

Put this above the test module in `src-tauri/src/session/registry.rs`:

```rust
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

pub struct Registry {
    windows: Mutex<BTreeMap<String, WindowEntry>>,
    /// Monotonic label counter. Never decremented on `forget`: reusing a
    /// label while a window with that label may still be booting is how you
    /// get two windows fighting over one registry slot.
    next_seq: Mutex<u32>,
}

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
```

Add `pub mod registry;` to `src-tauri/src/session/mod.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --workspace --no-fail-fast session::registry`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add the live window registry backing session state"
jj new
```

---

### Task 4: Path containment and target classification

**Files:**
- Create: `src-tauri/src/session/router.rs`
- Modify: `src-tauri/src/session/mod.rs` (add `pub mod router;`)
- Test: inline test module in `src-tauri/src/session/router.rs`

**Interfaces:**
- Consumes: `store::WindowEntry`.
- Produces: `session::router::{Target, Origin, Route, classify, contains, deepest_containing, is_blank}`.

These tests port `tests/shell/project-routing.test.ts`'s `deepestContainingFolder` block. Do not delete that file yet — Task 11 removes it along with its module.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/session/router.rs` with only this test module, then add the impl in Step 3.

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --workspace --no-fail-fast session::router`
Expected: FAIL — `classify` / `contains` not found.

- [ ] **Step 3: Write minimal implementation**

Put this above the test module in `src-tauri/src/session/router.rs`:

```rust
//! Pure routing decision for every open request. No Tauri types, no I/O —
//! everything the decision needs arrives as an argument, so the whole routing
//! table is directly testable.

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
```

Add `pub mod router;` to `src-tauri/src/session/mod.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --workspace --no-fail-fast session::router`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Add path containment and open-target classification"
jj new
```

---

### Task 5: Directory routing table

**Files:**
- Modify: `src-tauri/src/session/router.rs`
- Test: inline test module in `src-tauri/src/session/router.rs`

**Interfaces:**
- Consumes: `Target`, `Origin`, `Route`, `contains`, `deepest_containing`, `is_blank` from Task 4.
- Produces: `session::router::route_directory(dir: &str, origin: &Origin, windows: &[WindowEntry]) -> Route`.

This is the spec's Directory table:

| # | Condition | Route |
|---|---|---|
| 1 | a live window's folder `== d` | `Focus` |
| 2 | a live window's folder is an ancestor of `d` (deepest wins) | `Focus` + `reveal: d` |
| 3 | origin is in-app and the requesting window is blank | `Adopt` |
| 4 | exactly one live window, and it is blank | `Adopt` |
| 5 | — | `Spawn` |

- [ ] **Step 1: Write the failing test**

Append to `mod tests` in `src-tauri/src/session/router.rs`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --workspace --no-fail-fast session::router`
Expected: FAIL — `route_directory` not found.

- [ ] **Step 3: Write minimal implementation**

Add to `src-tauri/src/session/router.rs`, above the test module:

```rust
/// Route a directory open request. See the spec's Directory table.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --workspace --no-fail-fast session::router`
Expected: PASS, 24 tests.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Route directory open requests against the window registry"
jj new
```

---

### Task 6: File routing table and the public entry point

**Files:**
- Modify: `src-tauri/src/session/router.rs`
- Test: inline test module in `src-tauri/src/session/router.rs`

**Interfaces:**
- Consumes: everything from Tasks 4–5.
- Produces:
  - `session::router::route_file(file: &str, origin: &Origin, windows: &[WindowEntry], folder_root_of: &dyn Fn(&str) -> String) -> Route`
  - `session::router::route(target: &Target, origin: &Origin, windows: &[WindowEntry], folder_root_of: &dyn Fn(&str) -> String) -> Route`

`folder_root_of` is injected rather than called directly so `router.rs` stays I/O-free; production passes `commands::files::resolve_folder_root`.

This is the spec's File table:

| # | Condition | Route |
|---|---|---|
| 1 | a live window's current `path == f` | `Focus` |
| 2 | a live window's folder contains `f` (deepest wins) | `Focus` + `load: f` |
| 3 | origin is in-app and the requesting window is blank | `Adopt { folder: root(f), load: f }` |
| 4 | exactly one live window, and it is blank | same as 3 |
| 5 | — | `Spawn { folder: root(f), file: f }` |

- [ ] **Step 1: Write the failing test**

Append to `mod tests` in `src-tauri/src/session/router.rs`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --workspace --no-fail-fast session::router`
Expected: FAIL — `route_file` not found.

- [ ] **Step 3: Write minimal implementation**

Add to `src-tauri/src/session/router.rs`, above the test module:

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --workspace --no-fail-fast session::router`
Expected: PASS, 33 tests.

Run: `cargo clippy --workspace --all-targets --no-deps -- -D warnings`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Route document open requests against the window registry"
jj new
```

---

### Task 7: Cold-start restore plan

**Files:**
- Create: `src-tauri/src/session/launch.rs`
- Modify: `src-tauri/src/session/mod.rs` (add `pub mod launch;`)
- Test: inline test module in `src-tauri/src/session/launch.rs`

**Interfaces:**
- Consumes: `store::{SessionFile, WindowEntry}`, `commands::files::RecoveryEntry`.
- Produces: `session::launch::{PlannedWindow, restore_plan}`.

`restore_plan` is pure — existence checks arrive as a closure — so the whole launch decision is testable without a filesystem or an app handle.

Rules, from the spec:
- Dedupe by folder, newest `timestamp_ms` wins.
- A restored entry whose folder is gone drops the folder and falls back to its recorded file; if that is gone too, the entry is dropped.
- A restored entry whose file is gone keeps the window and clears `path`; the frontend's per-project fallback chain then runs.
- Each dump is paired with the planned window holding that path; unpaired dumps get their own window.
- An empty plan becomes one blank welcome window. The plan can never be empty.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/session/launch.rs` with only this test module, then add the impl in Step 3.

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --workspace --no-fail-fast session::launch`
Expected: FAIL — `restore_plan` not found.

- [ ] **Step 3: Write minimal implementation**

Put this above the test module in `src-tauri/src/session/launch.rs`:

```rust
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
    // A window with neither a project nor a document left is not worth
    // restoring — the user would get a blank window they never asked for.
    e.folder.is_some() || e.path.is_some()
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
```

Add `pub mod launch;` to `src-tauri/src/session/mod.rs`.

Note on geometry: `blank_entry` uses `x: 0, y: 0`. Task 8's spawner treats a zero-sized-or-unpositioned entry as "let the OS place it", so a welcome window is not pinned to the top-left corner.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --workspace --no-fail-fast session::launch`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Plan window restore from the persisted session and crash dumps"
jj new
```

---

### Task 8: Window spawning, effect execution, and commands

**Files:**
- Modify: `src-tauri/src/session/mod.rs`
- Test: `src-tauri/tests/session_launch.rs` is added in Task 14; this task is covered by the existing unit tests plus a compile-and-clippy gate.

**Interfaces:**
- Consumes: `registry::Registry`, `router::{Target, Origin, Route, classify, route}`, `launch::{PlannedWindow, restore_plan}`, `store::read_session`.
- Produces:
  - `session::SessionState { registry: Registry, app_data: PathBuf }`
  - `session::spawn_window(app: &AppHandle, planned: &PlannedWindow) -> tauri::Result<()>`
  - `session::apply_route(app: &AppHandle, route: Route)`
  - `session::open_paths(app: &AppHandle, paths: Vec<String>, requesting: Option<String>)`
  - commands `session_report`, `session_forget`, `session_open_paths`
  - `session::run_launch(app: &AppHandle)`

- [ ] **Step 1: Write the failing test**

There is no unit-testable seam here — this task is the Tauri boundary. The gate is that the crate compiles with the new commands registered and clippy stays clean. Add this compile-level assertion to `src-tauri/src/session/mod.rs` so the command signatures cannot silently drift:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --workspace --no-fail-fast session::tests`
Expected: FAIL — `window_url` not found.

- [ ] **Step 3: Write minimal implementation**

Replace `src-tauri/src/session/mod.rs` with:

```rust
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
```

Add `pub use` nothing further; `lib.rs` references these by path in Task 9.

Note: `read_all_recovery` and `RecoveryEntry` must be reachable from `session`. In `src-tauri/src/commands/files.rs`, confirm `RecoveryEntry` derives `Deserialize` as well as `Serialize` (it needs both — `read_all_recovery` already deserializes it) and that both are `pub`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --workspace --no-fail-fast session::`
Expected: PASS — the two `window_url` tests plus all earlier module tests.

Run: `cargo clippy --workspace --all-targets --no-deps -- -D warnings`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Execute routing decisions and spawn restored windows"
jj new
```

---

### Task 9: Wire the launch into the app lifecycle

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`
- Test: manual verification steps below; automated coverage lands in Task 14.

**Interfaces:**
- Consumes: `session::{SessionState, run_launch, open_paths, launch_done, session_report, session_forget, session_open_paths}`, `session::store::{read_session, write_session, migrate_from_plugin_store}`.
- Produces: no new public API.

- [ ] **Step 1: Remove the declarative window**

In `src-tauri/tauri.conf.json`, replace the `app.windows` array with an empty array:

```json
"windows": []
```

Leave every other `app.*` key untouched. Nothing must create a window before `run_launch` decides what to create.

- [ ] **Step 2: Register session state and run the migration in `setup`**

`SessionState` needs the resolved app-data dir, which first exists once there is an `AppHandle`. So unlike the other managed state it is registered **inside `setup`**, not in the builder chain — do not add a `.manage(SessionState::…)` line next to `.manage(WatcherState::new())`. Add this to the top of the existing `.setup(|app| { … })` closure, before the pairing server spawn:

```rust
// `SessionState` must always be registered: `run_launch` returns early
// without it, and with no declarative window that would leave the app with
// zero windows. So fall back to a temp dir rather than skipping — the
// session then fails to persist across launches on a broken system, but
// the user still gets a window.
let app_data = app
    .path()
    .app_data_dir()
    .unwrap_or_else(|_| std::env::temp_dir().join("marklig"));
// First launch after this change: adopt whatever the old TypeScript
// session code left in the plugin store, so an upgrade mid-session keeps
// its windows.
if !session::store::session_path(&app_data).exists() {
    let config_dir = app.path().app_config_dir().unwrap_or_else(|_| app_data.clone());
    if let Some(migrated) = session::store::migrate_from_plugin_store(&app_data, &config_dir) {
        if let Err(err) = session::store::write_session(&app_data, &migrated) {
            eprintln!("session migration write failed: {err}");
        }
    }
}
app.manage(session::SessionState::new(app_data));
```

- [ ] **Step 3: Replace the `Opened` and add the `Ready` arms**

Replace the existing `RunEvent::Opened` arm in `app.run(...)` with:

```rust
// macOS / file-association launches deliver paths here, not via argv.
// Before `run_launch` has restored the previous session there is nothing
// to route against, so buffer; afterwards route immediately. Same code
// path either way — that is what makes `md <path>` behave identically
// whether or not the app was already running.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
RunEvent::Opened { urls } => {
    let paths: Vec<String> = urls
        .into_iter()
        .filter_map(|u| {
            (u.scheme() == "file")
                .then(|| u.to_file_path().ok())
                .flatten()
                .and_then(|p| p.to_str().map(str::to_string))
        })
        .collect();
    if paths.is_empty() {
        return;
    }
    #[cfg(desktop)]
    {
        if session::launch_done() {
            session::open_paths(app, paths, None);
        } else if let Ok(mut pending) = PENDING_OPEN_PATHS.lock() {
            pending.extend(paths);
        }
    }
    #[cfg(not(desktop))]
    if let Ok(mut pending) = PENDING_OPEN_PATHS.lock() {
        pending.extend(paths);
    }
}
```

Add a new arm, before the `_ => {}` fallthrough:

```rust
// The event loop is live and any launch-time `Opened` has already been
// buffered. Restore the previous session, then route the arguments.
#[cfg(desktop)]
RunEvent::Ready => {
    let pending: Vec<String> = {
        #[cfg(target_os = "macos")]
        {
            PENDING_OPEN_PATHS.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Vec::new()
        }
    };
    session::run_launch(app, pending);
}
```

Replace the macOS `RunEvent::Reopen` arm's body with a router call, so a dock click goes through the same path as everything else:

```rust
#[cfg(target_os = "macos")]
RunEvent::Reopen { has_visible_windows, .. } if !has_visible_windows => {
    session::apply_route(app, session::router::Route::Spawn { folder: None, file: None });
}
```

Delete `fn spawn_main_window` and `fn encode_query_component` — `session::spawn_window` and `session::encode_component` replace them.

- [ ] **Step 4: Register the commands**

In the `#[cfg(desktop)]` `invoke_handler` list, add:

```rust
session::session_report,
session::session_forget,
session::session_open_paths,
```

and **remove** `take_pending_open_paths` from that desktop list. Keep it in the `#[cfg(mobile)]` list and keep the `fn take_pending_open_paths` definition — mobile still uses it.

- [ ] **Step 5: Verify the build and check the launch by hand**

Run: `cargo clippy --workspace --all-targets --no-deps -- -D warnings`
Expected: clean. If `PENDING_OPEN_PATHS` is now unused on a non-macOS desktop target, gate it the same way its `Opened` arm is.

Run: `cargo test --workspace --no-fail-fast`
Expected: PASS.

Run: `npm run tauri:dev`
Expected: exactly one window opens. Quit with Cmd-Q, relaunch: the same window returns. Close it with the red X, quit, relaunch: one welcome window.

- [ ] **Step 6: Commit**

```bash
jj desc -m "Restore windows at Ready and route launch arguments through Rust"
jj new
```

---

### Task 10: Frontend session client

**Files:**
- Create: `src/shell/session-client.ts`
- Delete: `src/shell/window-session.ts`, `src/shell/window-state.ts`
- Delete: `tests/shell/window-session.test.ts`
- Modify: `src/shell/close.ts`
- Test: `tests/shell/session-client.test.ts`

**Interfaces:**
- Consumes: Rust commands `session_report`, `session_forget`, `session_open_paths` from Task 8.
- Produces:
  - `installSessionReporting(getters): () => void`
  - `forgetWindow(label: string): Promise<void>`
  - `requestOpen(paths: string[], requesting?: string): Promise<void>`
  - `markUserClosingThisWindow(): void` (moved verbatim from `window-session.ts`)

- [ ] **Step 1: Write the failing test**

Create `tests/shell/session-client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "window-2",
    outerSize: async () => ({ width: 1800, height: 1200 }),
    outerPosition: async () => ({ x: 100, y: 200 }),
    scaleFactor: async () => 2,
  }),
}));

import { forgetWindow, installSessionReporting, requestOpen } from "../../src/shell/session-client";

describe("session-client", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  it("reports logical pixels, converting from physical via scaleFactor", async () => {
    const stop = installSessionReporting({
      currentPath: () => "/proj/a.md",
      folder: () => "/proj",
      dirty: () => false,
      scrollTop: () => 42.5,
      mode: () => "reading",
      sidebarVisible: () => true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const [cmd, args] = invoke.mock.calls[0];
    expect(cmd).toBe("session_report");
    expect(args).toMatchObject({
      label: "window-2",
      folder: "/proj",
      path: "/proj/a.md",
      dirty: false,
      x: 50,
      y: 100,
      width: 900,
      height: 600,
      scrollTop: 42.5,
      mode: "reading",
      sidebarVisible: true,
    });
    stop();
  });

  it("keeps reporting on a tick so a Cmd-Q teardown has fresh state", async () => {
    const stop = installSessionReporting({
      currentPath: () => null,
      folder: () => null,
      dirty: () => false,
      scrollTop: () => 0,
      mode: () => "reading",
    });
    await vi.advanceTimersByTimeAsync(0);
    const initial = invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1500);
    expect(invoke.mock.calls.length).toBeGreaterThan(initial);
    stop();
  });

  it("stops reporting once unsubscribed", async () => {
    const stop = installSessionReporting({
      currentPath: () => null,
      folder: () => null,
      dirty: () => false,
      scrollTop: () => 0,
      mode: () => "reading",
    });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    const after = invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(invoke.mock.calls.length).toBe(after);
  });

  it("clamps a negative scrollTop to zero", async () => {
    const stop = installSessionReporting({
      currentPath: () => null,
      folder: () => null,
      dirty: () => false,
      scrollTop: () => -20,
      mode: () => "reading",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls[0][1]).toMatchObject({ scrollTop: 0 });
    stop();
  });

  it("never rejects when the command fails", async () => {
    invoke.mockRejectedValue(new Error("no tauri"));
    const stop = installSessionReporting({
      currentPath: () => null,
      folder: () => null,
      dirty: () => false,
      scrollTop: () => 0,
      mode: () => "reading",
    });
    await expect(vi.advanceTimersByTimeAsync(1500)).resolves.not.toThrow();
    stop();
  });

  it("forgetWindow calls session_forget with the label", async () => {
    await forgetWindow("window-3");
    expect(invoke).toHaveBeenCalledWith("session_forget", { label: "window-3" });
  });

  it("requestOpen forwards paths and the requesting label", async () => {
    await requestOpen(["/proj"], "window-2");
    expect(invoke).toHaveBeenCalledWith("session_open_paths", {
      paths: ["/proj"],
      requesting: "window-2",
    });
  });

  it("requestOpen sends a null requester for an external request", async () => {
    await requestOpen(["/proj"]);
    expect(invoke).toHaveBeenCalledWith("session_open_paths", {
      paths: ["/proj"],
      requesting: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shell/session-client.test.ts`
Expected: FAIL — cannot resolve `src/shell/session-client`.

- [ ] **Step 3: Write minimal implementation**

Create `src/shell/session-client.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The frontend half of the Rust-owned session. This module only *reports* —
 * it never decides. Restore, routing, and window creation all live in
 * `src-tauri/src/session/`, which is what keeps a cold launch and a warm
 * `md <path>` on one code path.
 */

export type WindowMode = "reading" | "edit";

export interface SessionGetters {
  currentPath: () => string | null;
  folder: () => string | null;
  dirty: () => boolean;
  scrollTop: () => number;
  mode: () => WindowMode;
  sidebarVisible?: () => boolean;
}

/** How often to push this window's state to Rust. On macOS, Cmd-Q tears
 *  windows down without firing per-window close events, so the last tick is
 *  what the next launch restores from. */
const REPORT_TICK_MS = 1500;

async function report(getters: SessionGetters): Promise<void> {
  try {
    const win = getCurrentWindow();
    const [size, pos, factor] = await Promise.all([
      win.outerSize(),
      win.outerPosition(),
      win.scaleFactor(),
    ]);
    // outerSize/outerPosition are physical pixels; the Rust spawner sets
    // logical ones, so normalise here or a HiDPI window doubles each launch.
    await invoke("session_report", {
      label: win.label,
      folder: getters.folder(),
      path: getters.currentPath(),
      dirty: getters.dirty(),
      x: Math.round(pos.x / factor),
      y: Math.round(pos.y / factor),
      width: Math.round(size.width / factor),
      height: Math.round(size.height / factor),
      scrollTop: Math.max(0, getters.scrollTop()),
      mode: getters.mode(),
      sidebarVisible: getters.sidebarVisible?.() ?? null,
    });
  } catch {
    // Best-effort: a failed report must never block window close or quit.
  }
}

/** Start reporting this window's state. Returns the unsubscribe. */
export function installSessionReporting(getters: SessionGetters): () => void {
  // Immediate write so even an instant quit after launch has state.
  void report(getters);
  const interval = window.setInterval(() => { void report(getters); }, REPORT_TICK_MS);

  // Last-line backstop for the Cmd-Q teardown path. Skipped when the user
  // closed this window on purpose — `close.ts` has already called
  // `forgetWindow`, and a redundant report would resurrect it (issue #34).
  const onBeforeUnload = (): void => {
    if (userClosingThisWindow) return;
    void report(getters);
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    window.clearInterval(interval);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
}

/** Drop this window from the session — it was closed deliberately. */
export async function forgetWindow(label: string): Promise<void> {
  try {
    await invoke("session_forget", { label });
  } catch {
    // ignore
  }
}

/** Ask Rust to route an open request. `requesting` is this window's label for
 *  in-app actions (Switch Project, folder drag-drop) and omitted for anything
 *  the user aimed at the app from outside. */
export async function requestOpen(
  paths: string[],
  requesting?: string,
): Promise<void> {
  try {
    await invoke("session_open_paths", { paths, requesting: requesting ?? null });
  } catch {
    // ignore
  }
}

// Set by close.ts while its close-requested handler is mid-flight, so the
// `beforeunload` fired by the subsequent destroy() doesn't undo the forget.
let userClosingThisWindow = false;
export function markUserClosingThisWindow(): void {
  userClosingThisWindow = true;
}
```

Update `src/shell/close.ts`: change the import on line 5 to

```ts
import { forgetWindow, markUserClosingThisWindow } from "./session-client";
```

and replace the `await removeWindowSessionEntry(win.label);` call with `await forgetWindow(win.label);`. Everything else in that file is unchanged.

Delete `src/shell/window-session.ts`, `src/shell/window-state.ts`, and `tests/shell/window-session.test.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/shell/session-client.test.ts tests/shell/close.test.ts`
Expected: PASS. If `close.test.ts` mocks `./window-session`, retarget that mock to `./session-client` and rename the asserted call to `session_forget`.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Report window state to the Rust session owner"
jj new
```

---

### Task 11: Frontend reads its initial state from URL parameters only

**Files:**
- Modify: `src/main.ts`
- Delete: `src/shell/project-routing.ts`, `tests/shell/project-routing.test.ts`
- Test: `npx tsc -b --noEmit` plus the existing suite

**Interfaces:**
- Consumes: `session-client.ts` from Task 10; the `?folder=&file=&scrollTop=&mode=&dump=` contract from Task 8's `window_url`.
- Produces: `resolveInitial(): Promise<{ doc: OpenedDoc | null; folder: string | null }>` — now parameterless.

This is the largest single deletion in the plan. Work through it in the order below; each bullet is independently checkable with `npx tsc -b --noEmit`.

- [ ] **Step 1: Replace `resolveInitial` with the parameter reader**

Delete the entire body of `resolveInitial` (currently `src/main.ts:2020`–`2130`, the block ending at `return { doc: await openFileViaDialog(), folder: null };`) and replace it with:

```ts
/**
 * Every window's initial state now arrives as URL parameters set by Rust's
 * `session::window_url`. The frontend decides nothing: recovery pairing,
 * session restore, launch arguments, and project fallback ordering are all
 * resolved in `src-tauri/src/session/launch.rs` before this window exists.
 */
async function resolveInitial(): Promise<{ doc: OpenedDoc | null; folder: string | null }> {
  const folder = folderFromUrlQuery();
  const file = fileFromUrlQuery();

  if (file) {
    try {
      return { doc: await readDoc(file), folder };
    } catch {
      // Deleted between the plan and this window booting — fall through to
      // the project fallback chain below rather than showing an error.
    }
  }
  if (folder) {
    const fallback = await resolveProjectFallbackFile(folder);
    if (fallback) {
      try {
        return { doc: await readDoc(fallback), folder };
      } catch {
        // Listed but unreadable — welcome buffer inside the project.
      }
    }
    return { doc: null, folder };
  }
  return { doc: null, folder: null };
}
```

- [ ] **Step 2: Delete the functions that fed the old chain**

Remove from `src/main.ts` entirely: `loadAndApplySession`, `tryReopenLastFile`, `waitForOpenRequest`, `takePendingOpenPaths`, `classifyOpenPaths`, `firstMarkdownArg`, `spawnRestoredWindow`, `nextWindowLabel`, and the `nextWindowSeq` module variable. Remove the now-unused imports of `loadWindowSession`, `clearWindowSession`, `dedupeSessionByFolder`, `decideProjectRoute`, `deepestContainingFolder`, `WindowSessionEntry`, `restoreWindowState`, and `installWindowStatePersistence`.

In `bootstrap`, delete the `const sessionEntryForThisWindow = await loadAndApplySession();` line and the `sessionFallbackPath` / `sessionFallbackFolder` consts, and change the call site to `const { doc: initialDoc, folder: initialFolder } = await resolveInitial();`. Replace the `await restoreWindowState(); installWindowStatePersistence();` pair with nothing — Rust sets geometry at spawn time and `session-client` persists it.

Keep `if (isMainWindow()) await maybeRestoreFromRecovery();` for now; Task 13 rewrites it.

- [ ] **Step 3: Delete the routing map and its handshake**

Remove the `folderByLabel` map and every reader of it, the `routeToFolder` function, the `unsubFileOpen` `file-open-request` listener block, the `unsubSwitchProject` listener, the `unsubAnnounceRequest` listener, the `viewer:window-folder` / `viewer:window-closed` listeners and their `emit` calls, and the two `emit("viewer:request-folder-announce")` calls with their 250 ms timer. Keep `raiseWindow` only if something still calls it; otherwise delete it too.

Replace `spawnNewWindow(opts)` with a call into Rust. Every existing call site — the multi-file drag-drop loop, `File → New Window`, the folder-drop handler — becomes:

```ts
await requestOpen(paths, selfLabel);
```

where `paths` is the array of dropped/target paths.

`File → New Window` has no target, so it does not go through the router at all — routing an empty path list would do nothing. It gets its own command. Add to `src-tauri/src/session/mod.rs`:

```rust
/// `File → New Window`: a blank window, unconditionally. Not a routing
/// decision — the user asked for a new window, not for a document.
#[tauri::command]
pub fn session_new_window(app: AppHandle) {
    apply_route(&app, Route::Spawn { folder: None, file: None });
}
```

Register it next to the other three in `lib.rs`, and expose it from `session-client.ts`:

```ts
export async function newWindow(): Promise<void> {
  try {
    await invoke("session_new_window");
  } catch {
    // ignore
  }
}
```

- [ ] **Step 4: Point the in-app project switch at Rust**

Replace the body of the `viewer:switch-project-request` emit site (in the project palette / Switch Project action) with a direct `requestOpen([folder], selfLabel)`, and delete the `viewer:switch-project-request` listener. The `viewer:adopt-folder` listener stays — Rust now emits it.

Delete `src/shell/project-routing.ts` and `tests/shell/project-routing.test.ts`.

- [ ] **Step 5: Wire the session reporter**

In `bootstrap`, where `installWindowSessionPersistence` was called, call:

```ts
const stopSessionReporting = installSessionReporting({
  currentPath: () => currentPath,
  folder: () => currentFolder,
  dirty: () => dirtyTracker.isDirty(),
  scrollTop: () => view.scrollDOM.scrollTop,
  mode: () => currentMode,
  sidebarVisible: () => folder.element.dataset.visible === "true",
});
window.addEventListener("beforeunload", () => stopSessionReporting());
```

Match `sidebarVisible` to however the existing code already determines sidebar visibility for the old `installWindowSessionPersistence` call — reuse that same getter verbatim rather than inventing a new one.

- [ ] **Step 6: Verify**

Run: `npx tsc -b --noEmit`
Expected: clean. Every remaining error names a symbol from the deleted set; remove its last user.

Run: `npm test`
Expected: PASS. Delete any test that only exercised deleted code.

Run: `npm run tauri:dev`
Expected: one window. `File → New Window` opens a second, blank. Closing it and quitting leaves one window on the next launch.

- [ ] **Step 7: Commit**

```bash
jj desc -m "Read window state from launch parameters instead of routing in the frontend"
jj new
```

---

### Task 12: Reveal a subdirectory without re-rooting

**Files:**
- Modify: `src/ui/sidebar/folder.ts`
- Modify: `src/main.ts`
- Test: `tests/ui/folder-reveal.test.ts`

**Interfaces:**
- Consumes: the `viewer:reveal-path` event emitted by `apply_route` in Task 8, payload `{ label: string; path: string }`.
- Produces: `FolderSidebarHandle.revealDirectory(absolutePath: string): void`.

This is what stops `md ~/proj/docs` from being a silent no-op when a window rooted at `~/proj` absorbs it.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/folder-reveal.test.ts`. Mirror the mocking style of the nearest existing sidebar test (`tests/e2e` aside, look at how `tests/shell/project-fallback.test.ts` mocks `@tauri-apps/api/core`) so `list_documents` returns a fixed tree:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { mountFolderSidebar } from "../../src/ui/sidebar/folder";

const TREE = [
  { path: "/proj/readme.md", relative: "readme.md" },
  { path: "/proj/docs/api.md", relative: "docs/api.md" },
  { path: "/proj/docs/deep/x.md", relative: "docs/deep/x.md" },
];

describe("revealDirectory", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) =>
      cmd === "list_documents" ? Promise.resolve(TREE) : Promise.resolve(null),
    );
    document.body.innerHTML = "";
  });

  it("expands the requested directory without changing the root", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/proj");

    handle.revealDirectory("/proj/docs");

    const docs = parent.querySelector('[data-dir-relative="docs"]');
    expect(docs?.getAttribute("aria-expanded")).toBe("true");
    // Root is untouched — this is a reveal, not a re-root.
    expect(parent.querySelector("[data-folder-root]")?.getAttribute("data-folder-root"))
      .toBe("/proj");
  });

  it("expands every ancestor on the way down", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/proj");

    handle.revealDirectory("/proj/docs/deep");

    expect(parent.querySelector('[data-dir-relative="docs"]')?.getAttribute("aria-expanded"))
      .toBe("true");
    expect(parent.querySelector('[data-dir-relative="docs/deep"]')?.getAttribute("aria-expanded"))
      .toBe("true");
  });

  it("ignores a directory outside the current root", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/proj");

    expect(() => handle.revealDirectory("/elsewhere/docs")).not.toThrow();
    expect(parent.querySelector('[data-dir-relative="docs"]')?.getAttribute("aria-expanded"))
      .not.toBe("true");
  });
});
```

Adjust the selectors (`data-dir-relative`, `data-folder-root`, `aria-expanded`) to the attributes `folder.ts` actually renders — read the file first and use its real markup. Do not add new attributes unless the file has none that identify a directory row; if it has none, add `data-dir-relative` in Step 3 and keep the selector.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/folder-reveal.test.ts`
Expected: FAIL — `revealDirectory` is not a function.

- [ ] **Step 3: Write minimal implementation**

Add to the `FolderSidebarHandle` interface in `src/ui/sidebar/folder.ts`:

```ts
  /** Expand the tree down to `absolutePath` and scroll it into view, WITHOUT
   *  changing the root. Used when an open request names a subdirectory of a
   *  root this window already shows — `md ~/proj/docs` on a `~/proj` window
   *  should visibly do something, but must not move the user's project out
   *  from under them. No-op if the path is outside the current root. */
  revealDirectory: (absolutePath: string) => void;
```

Implement it next to `setActiveFile`, reusing the module's existing expansion state (the same set `refresh` preserves) rather than adding a parallel one:

```ts
  function revealDirectory(absolutePath: string): void {
    if (!currentRoot) return;
    const rootSegs = currentRoot.split("/").filter(Boolean);
    const targetSegs = absolutePath.split("/").filter(Boolean);
    if (targetSegs.length <= rootSegs.length) return;
    if (!rootSegs.every((s, i) => s === targetSegs[i])) return;

    // Expand every ancestor between the root and the target, inclusive, so
    // the target row exists in the DOM before we scroll to it.
    const relSegs = targetSegs.slice(rootSegs.length);
    for (let i = 1; i <= relSegs.length; i++) {
      expanded.add(relSegs.slice(0, i).join("/"));
    }
    render();
    const row = element.querySelector<HTMLElement>(
      `[data-dir-relative="${CSS.escape(relSegs.join("/"))}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }
```

Return `revealDirectory` from the handle. Use the file's real names for `currentRoot`, `expanded`, and `render` — read them out of `folder.ts` rather than assuming these.

In `src/main.ts`, add the listener next to the `viewer:open-file` one:

```ts
  // Rust routed a directory request to this window because our tree contains
  // it. Reveal it in place — the root deliberately does not move.
  const unsubReveal = await listen<{ label: string; path: string }>(
    "viewer:reveal-path",
    (e) => {
      const { label, path } = e.payload ?? { label: "", path: "" };
      if (label !== selfLabel || !path) return;
      folder.revealDirectory(path);
    },
  );
  window.addEventListener("beforeunload", () => unsubReveal());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ui/folder-reveal.test.ts`
Expected: PASS, 3 tests.

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Reveal a requested subdirectory in the window that already contains it"
jj new
```

---

### Task 13: Per-window crash recovery

**Files:**
- Modify: `src/main.ts`
- Test: `tests/shell/recovery.test.ts` (extend)

**Interfaces:**
- Consumes: the `?dump=<original path>` URL parameter set by Task 8's `window_url`; `readAllRecovery` / `clearRecovery` from `src/shell/recovery.ts`; `resolveRecoveryAction` (unchanged).
- Produces: `dumpFromUrlQuery(): string | null` in `src/main.ts`.

Rust already decided which window owns which dump. This window only loads the one it was handed.

- [ ] **Step 1: Write the failing test**

Append to `tests/shell/recovery.test.ts`:

```ts
describe("resolveRecoveryAction scoped to one dump", () => {
  it("selects only the entry matching the requested path", async () => {
    const entries = [
      { originalPath: "/a/x.md", contents: "edited x", timestampMs: 1 },
      { originalPath: "/b/y.md", contents: "edited y", timestampMs: 9 },
    ];
    const mine = entries.filter((e) => e.originalPath === "/a/x.md");
    const action = await resolveRecoveryAction(mine, async () => "on disk x");
    expect(action.kind).toBe("load");
    if (action.kind === "load") {
      expect(action.path).toBe("/a/x.md");
      expect(action.source).toBe("edited x");
    }
  });

  it("yields no action when the requested path has no dump", async () => {
    const action = await resolveRecoveryAction([], async () => "on disk");
    expect(action.kind).toBe("none");
  });
});
```

Match the property spelling (`originalPath` vs `original_path`) to what `src/shell/recovery.ts` already uses — read it first.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shell/recovery.test.ts`
Expected: PASS for these two if `resolveRecoveryAction` already filters correctly — in which case they are regression guards and you move straight to Step 3. FAIL means the newest-dump-wins behaviour is still in the resolver; move the selection out to the caller as Step 3 describes.

- [ ] **Step 3: Write minimal implementation**

In `src/main.ts`, add next to `fileFromUrlQuery`:

```ts
function dumpFromUrlQuery(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const d = params.get("dump");
    return d && d.length > 0 ? d : null;
  } catch {
    return null;
  }
}
```

Replace the `maybeRestoreFromRecovery` body's first line and its call gate:

```ts
  async function maybeRestoreFromRecovery(): Promise<void> {
    // Which dump belongs to this window was decided in
    // `src-tauri/src/session/launch.rs`, which pairs each dump with the
    // window that owns its file and gives an unclaimed dump a window of its
    // own. We load exactly the one we were handed — no window scans the
    // whole recovery store any more, which is what used to make a secondary
    // window's dump land in `main` or vanish.
    const wanted = dumpFromUrlQuery();
    if (!wanted) return;
    const entries = (await readAllRecovery()).filter((e) => e.originalPath === wanted);
    if (entries.length === 0) return;
    const action = await resolveRecoveryAction(entries, async (path) => {
      try {
        const doc = await readDoc(path);
        return doc.source;
      } catch {
        return null;
      }
    });
    if (action.kind === "none") return;
    if (action.kind === "load") {
      recoveredDoc = {
        path: action.path,
        source: action.source,
        diskBaseline: action.diskBaseline,
      };
    }
    await clearRecovery(action.path);
  }
```

Change the call site from `if (isMainWindow()) await maybeRestoreFromRecovery();` to `await maybeRestoreFromRecovery();`.

`recoveredDoc` must now win over the URL `file` param in `resolveInitial`, since a dump is unsaved work. Add at the top of `resolveInitial`:

```ts
  if (recoveredDoc) return { doc: recoveredDoc, folder: folderFromUrlQuery() };
```

Delete `isMainWindow()` and `currentWindowLabel()` if nothing else calls them; otherwise leave them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/shell/recovery.test.ts`
Expected: PASS.

Run: `npx tsc -b --noEmit && npm test`
Expected: clean, PASS.

Manual check: open a file, type without saving, `kill -9` the app, relaunch. The window returns with the edit and a lit dirty dot.

- [ ] **Step 5: Commit**

```bash
jj desc -m "Restore each crash dump into the window that owns its file"
jj new
```

---

### Task 14: Launch integration test and documentation

**Files:**
- Create: `src-tauri/tests/session_launch.rs`
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `ROADMAP.md`
- Test: the new integration test

**Interfaces:**
- Consumes: `marklig_lib::session::{store, launch, router}` — these must be reachable from an integration test, so `mod session;` in `lib.rs` becomes `pub mod session;` (still `#[cfg(desktop)]`), matching how `pub mod typst;` is exposed for `typst_basic.rs`.

This is the test that makes a wrong route fail the suite instead of passing quietly. It exercises plan-then-route end to end without a running app: build a session, run `restore_plan`, feed the plan into the registry, then route the launch arguments and assert the resulting window set.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/tests/session_launch.rs`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --workspace --no-fail-fast --test session_launch`
Expected: FAIL — `marklig_lib::session` is private.

- [ ] **Step 3: Make the module public and fix what falls out**

In `src-tauri/src/lib.rs`, change the declaration added in Task 1 to:

```rust
// Public so `tests/session_launch.rs` can drive the restore plan and the
// router directly, the way `typst` is exposed for `typst_basic.rs`.
#[cfg(desktop)]
pub mod session;
```

`tempfile` is already a dev-dependency, so no `Cargo.toml` change is needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --workspace --no-fail-fast`
Expected: PASS — 8 new integration tests plus every unit test from Tasks 1–8.

Run: `cargo clippy --workspace --all-targets --no-deps -- -D warnings`
Expected: clean.

Run: `npm test && npx tsc -b --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Update the documentation**

In `CLAUDE.md`, replace the "File lifecycle (`src/shell/`)" bullet list's multi-window paragraph and add a new subsection after it:

```markdown
### Session, launch, and open-routing (`src-tauri/src/session/`)

There is **no privileged `main` window** and no window in `tauri.conf.json`.
Rust creates every window at `RunEvent::Ready` and owns all routing:

- `store.rs` — `<app_data>/session.json`, atomic writes, one-time migration
  off the old `windowSession:*` plugin-store keys.
- `registry.rs` — the live `label → WindowEntry` map. It is *also* what gets
  serialized, so the routing map and the session file cannot drift apart.
- `router.rs` — pure decision: `Focus | Adopt | Spawn`. No Tauri types, no I/O;
  `resolve_folder_root` is injected, which is what makes the whole routing
  table unit-testable.
- `launch.rs` — the restore plan: dedupe by folder (newest wins), reconcile
  against disk, pair crash dumps to the window owning each file. **It can
  never return an empty plan** — with no declarative window, that guard is the
  only thing standing between a corrupt `session.json` and a window-less app.

`RunEvent::Opened` fires *before* `setup` on macOS cold launch, so the restore
runs at `Ready`: buffer arguments, restore windows, then route the buffer.
`spawn_window` seeds the registry **synchronously** from the entry it already
holds rather than waiting for the webview to report — that wait was the race
that made cold-start arguments behave differently from warm ones.

The frontend decides nothing about startup. Every window reads `?folder=`,
`?file=`, `?scrollTop=`, `?mode=`, and `?dump=` and loads exactly that;
`src/shell/session-client.ts` only reports state back. `emit_to` still does not
scope a global `listen()` in Tauri v2, so `viewer:open-file`, `viewer:adopt-folder`,
and `viewer:reveal-path` all carry their target label in the payload — do not
"simplify" that away (see #145).
```

Add a CHANGELOG entry under the unreleased heading:

```markdown
- Startup, shutdown, and window-session state are now owned by Rust. `md <dir>`
  and `md <file>` raise the window that already covers the target instead of
  opening a duplicate, cold start restores the previous session before applying
  launch arguments, and closing every window means the next launch shows a
  welcome buffer rather than reopening the last file.
```

In `ROADMAP.md`, note under sub-spec D that multi-window session restore and CLI
open-routing are now Rust-owned.

- [ ] **Step 6: Manual acceptance pass**

Build and install per the repo's usual flow, then walk the spec's scenarios:

1. Open project A. Quit. Relaunch → A returns, alone.
2. Open A and B in two windows. Quit. Relaunch → both return.
3. With A and B open, `md <file in B>` → B raises with the file. No third window.
4. Quit. `md <file in B>` → A and B restore, B raises with the file. Three windows would be a failure.
5. `md <C>` where C is a new project → A, B restore and a third window opens on C.
6. `md <subdir of A>` → A raises, root unchanged, the subdirectory expands.
7. Close every window with the red X, quit, relaunch → one welcome window.
8. Close the first window created, then `md <file>` → still routes correctly (no `main` to depend on).

- [ ] **Step 7: Commit**

```bash
jj desc -m "Add cold-launch routing integration tests and document the session module"
jj new
```

---

## Self-Review Notes

Spec coverage check against `2026-08-11-session-startup-routing-design.md`:

| Spec section | Task |
|---|---|
| `store.rs` format + atomic write | 1 |
| Plugin-store migration | 2 |
| `registry.rs` | 3 |
| `router.rs` helpers + classification | 4 |
| Directory routing table | 5 |
| File routing table | 6 |
| `launch.rs` restore plan + dump pairing | 7 |
| `spawn_window`, effect execution, commands | 8 |
| `Ready`-not-`setup`, `tauri.conf.json` window removal, `take_pending_open_paths` | 9 |
| `session-client.ts`, retiring `window-session`/`window-state` | 10 |
| Frontend URL-param-only bootstrap, deleting `folderByLabel` and the handshake | 11 |
| `viewer:reveal-path` + `revealDirectory` | 12 |
| Per-window crash recovery via `?dump=` | 13 |
| Integration tests + docs | 14 |

Defects 1–7 from the spec map to: 1 → Task 9 + 14; 2 → Tasks 6, 14; 3 → Task 6 (file rule 4); 4 → Tasks 9, 11 (no `main` gate survives); 5 → Task 11 (`firstMarkdownArg` deleted); 6 → Task 7 (dedupe is now the only path, with no separate main-window branch to disagree with it); 7 → Task 7 (`reconcile_with_disk` drops empty entries) + Task 11 (`recents[0]` fallback deleted).

Two things a reviewer should watch for, since they are where this plan is most likely to be wrong about the existing code:

- **Task 11 is a large deletion in a 2528-line file.** The listed symbols are the ones the current code has; if `npx tsc -b --noEmit` names something not on the list, delete its last user rather than reintroducing a shim.
- **Task 12's selectors are guesses.** `src/ui/sidebar/folder.ts` was not read closely enough to pin its markup. Read it first and use the real attribute names; the test is written to be adjusted, not to dictate the DOM.
