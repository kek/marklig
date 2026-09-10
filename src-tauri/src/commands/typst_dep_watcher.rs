//! Watches the files a Typst compile actually read, so that editing an import
//! recompiles the preview.
//!
//! `commands::watcher` watches the *open document*; a change there means the
//! buffer on screen is stale, so it runs the reconcile flow (silent reload,
//! dirty-prompt, orphan notice). This watcher answers a different question:
//! a file the document *imports* changed, so the render is stale but the
//! buffer is not. Nothing should be reloaded — only recompiled. That is why
//! it is a separate watcher emitting a separate event rather than more paths
//! bolted onto the document watcher.
//!
//! The set comes from `CompileResult::dependencies`, which the compiler
//! collects by recording what it read — not by parsing import statements. So
//! it covers transitive imports, `read()`, and `image()` alike, at any depth.
//!
//! Like the document watcher this watches *directories* non-recursively (one
//! per distinct parent) and filters events down to the paths of interest.
//! Missing parents use a recursive watch on the nearest existing ancestor, so
//! creating the directory and import can trigger the first successful compile.
//! Watching each file directly would miss the atomic-save pattern most editors
//! use, where the file is replaced rather than written in place.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::{event::ModifyKind, EventKind, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebouncedEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Window};

use crate::commands::watcher::TargetMatcher;

#[derive(Debug, Serialize, Clone)]
pub struct DependencyChangedEvent {
    /// The dependency path spelled exactly as the frontend asked us to watch
    /// it, so it can be compared against the set the frontend holds.
    pub path: String,
}

/// Per-window dependency watcher. Keyed by window label for the same reason
/// the document watcher is: two windows can have different `.typ` files open,
/// each with its own import graph.
pub struct TypstDepWatcherState {
    inner: Mutex<HashMap<String, DepWatcher>>,
}

impl TypstDepWatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for TypstDepWatcherState {
    fn default() -> Self {
        Self::new()
    }
}

struct DepWatcher {
    /// Exactly what this watcher was built for. `typst_watch_dependencies` is
    /// called after *every* compile — which is every ~300ms while the user
    /// types — but the import graph changes only when an import is added or
    /// removed. Comparing against this makes the common call a lock and a set
    /// comparison instead of tearing down and re-establishing kernel watches.
    paths: BTreeSet<String>,
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::FileIdMap,
    >,
}

/// Turn a dependency set into what `notify` needs: one matcher per dependency
/// (paired with the verbatim spelling to report back), and the distinct set of
/// directories to watch.
///
/// Matchers keep the verbatim spelling so the event we emit is the one the
/// frontend can recognise, while still matching the canonical spelling
/// FSEvents reports on macOS. See `TargetMatcher` for why both are needed.
///
/// Imports routinely live in a subdirectory of the entry file's, so the
/// directory set is genuinely a set — deduplicated, and usually smaller than
/// the dependency list.
fn watch_plan(paths: &BTreeSet<String>) -> (Vec<(String, TargetMatcher)>, BTreeSet<PathBuf>) {
    let matchers = paths
        .iter()
        .map(|p| (p.clone(), TargetMatcher::new(std::path::Path::new(p))))
        .collect();
    let parents = paths
        .iter()
        .filter_map(|p| PathBuf::from(p).parent().map(|d| d.to_path_buf()))
        .collect();
    (matchers, parents)
}

/// Install (or update) the dependency watch set for this window.
///
/// Pass the compile's dependency list minus the entry file — the document
/// watcher already covers that one, and routing it through here too would
/// recompile twice for a single save.
///
/// An empty list tears the watcher down, which is what closing a `.typ` file
/// or switching to a Markdown document should do.
#[tauri::command]
pub fn typst_watch_dependencies(
    app: AppHandle,
    window: Window,
    state: tauri::State<'_, TypstDepWatcherState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let report_label = label.clone();
    state.sync(label, paths.into_iter().collect(), move |path| {
        let _ = app.emit_to(
            report_label.as_str(),
            "viewer://typst-dependency-changed",
            DependencyChangedEvent { path },
        );
    })
}

impl TypstDepWatcherState {
    fn sync(
        &self,
        label: String,
        wanted: BTreeSet<String>,
        on_changed: impl Fn(String) + Send + 'static,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if wanted.is_empty() {
            guard.remove(&label);
            return Ok(());
        }
        if guard.get(&label).is_some_and(|w| w.paths == wanted) {
            return Ok(());
        }
        // Publish the new set only after every kernel watch is installed.
        // An error keeps the previous watcher alive and leaves the set retryable.
        let watcher = DepWatcher::new(wanted, on_changed)?;
        guard.insert(label, watcher);
        Ok(())
    }
}

impl DepWatcher {
    fn new(
        paths: BTreeSet<String>,
        on_changed: impl Fn(String) + Send + 'static,
    ) -> Result<Self, String> {
        let (matchers, parents) = watch_plan(&paths);

        let mut debouncer = new_debouncer(
            Duration::from_millis(150),
            None,
            move |result: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
                let Ok(events) = result else { return };
                for ev in events {
                    // Removal is not special-cased the way it is for the open
                    // document. A deleted import is a compile error, and the
                    // compiler already reports that far better than this watcher
                    // could — so every event kind means the same thing here:
                    // recompile and let the diagnostics speak.
                    // A mkdir + write burst can finish before inotify arms a
                    // newly created subdirectory. Treat changes to a dependency's
                    // ancestors as invalidations too, reporting the dependency
                    // spelling the frontend knows, not the directory's name.
                    let structural = matches!(
                        ev.kind,
                        EventKind::Create(_)
                            | EventKind::Remove(_)
                            | EventKind::Modify(ModifyKind::Name(_))
                    );
                    let Some((path, _)) = matchers.iter().find(|(_, m)| {
                        m.matches_any(&ev.paths)
                            || (structural && ev.paths.iter().any(|p| m.matches_ancestor(p)))
                    }) else {
                        continue;
                    };
                    on_changed(path.clone());
                }
            },
        )
        .map_err(|e| e.to_string())?;

        // Deduplicate fallback roots, with recursive winning if a root is also
        // an ordinary dependency parent. Keep the fallback armed for this set's
        // lifetime: the frontend deliberately skips unchanged dependency sets.
        let mut roots = BTreeMap::new();
        for parent in parents {
            let mut root = parent.clone();
            while !root.try_exists().map_err(|e| e.to_string())? {
                if !root.pop() {
                    return Err(format!("no existing ancestor for {}", parent.display()));
                }
            }
            if !root.is_dir() {
                return Err(format!(
                    "dependency parent is not a directory: {}",
                    root.display()
                ));
            }
            let recursive = root != parent;
            *roots.entry(root).or_insert(false) |= recursive;
        }
        for (dir, recursive) in roots {
            let mode = if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            debouncer
                .watcher()
                .watch(&dir, mode)
                .map_err(|err| format!("typst dep watch failed for {}: {err}", dir.display()))?;
        }

        Ok(Self {
            paths,
            _debouncer: debouncer,
        })
    }
}

/// Drop this window's dependency watcher. Called when the Typst session
/// closes; also reachable by passing an empty list to the command above.
#[tauri::command]
pub fn typst_unwatch_dependencies(
    window: Window,
    state: tauri::State<'_, TypstDepWatcherState>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    guard.remove(window.label());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn set(paths: &[&str]) -> BTreeSet<String> {
        paths.iter().map(|p| (*p).to_string()).collect()
    }

    #[test]
    fn watch_plan_deduplicates_directories() {
        let (matchers, parents) = watch_plan(&set(&[
            "/cv/main.typ",
            "/cv/strings.typ",
            "/cv/sub/level1.typ",
        ]));
        assert_eq!(matchers.len(), 3);
        assert_eq!(
            parents,
            [PathBuf::from("/cv"), PathBuf::from("/cv/sub")]
                .into_iter()
                .collect::<BTreeSet<_>>(),
            "three dependencies across two directories should need two watches",
        );
    }

    /// Exercise the production constructor and callback, not a second watcher
    /// assembled in the test. Sibling events must not invalidate the preview.
    #[test]
    fn delivers_an_event_for_an_import_in_a_subdirectory() {
        let root = tempfile::tempdir().unwrap();
        let sub = root.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let leaf = sub.join("leaf.typ");
        let unrelated = sub.join("notes.txt");
        std::fs::write(&leaf, "original").unwrap();
        std::fs::write(&unrelated, "unrelated").unwrap();
        let (tx, rx) = channel();
        let _watcher = DepWatcher::new(set(&[leaf.to_str().unwrap()]), move |path| {
            let _ = tx.send(path);
        })
        .unwrap();
        std::fs::write(&unrelated, "still unrelated").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
        std::fs::write(&leaf, "changed").unwrap();
        receive_path(&rx, &leaf);
    }

    #[test]
    fn recursive_fallback_ignores_unrelated_directories() {
        let root = tempfile::tempdir().unwrap();
        let leaf = root.path().join("new/nested/leaf.typ");
        let (tx, rx) = channel();
        let _watcher = DepWatcher::new(set(&[leaf.to_str().unwrap()]), move |path| {
            let _ = tx.send(path);
        })
        .unwrap();
        std::fs::create_dir(root.path().join("unrelated")).unwrap();
        std::fs::write(root.path().join("unrelated/notes.typ"), "unrelated").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
        std::fs::create_dir_all(leaf.parent().unwrap()).unwrap();
        std::fs::write(&leaf, "created").unwrap();
        receive_path(&rx, &leaf);
    }

    #[cfg(unix)]
    #[test]
    fn missing_parents_keep_canonical_event_matching() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        let alias = root.path().join("alias");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let leaf = alias.join("new/nested/leaf.typ");
        let canonical = real.canonicalize().unwrap();
        let matcher = TargetMatcher::new(&leaf);
        assert!(matcher.matches_any(&[canonical.join("new/nested/leaf.typ")]));
        assert!(matcher.matches_ancestor(&canonical.join("new")));
        assert!(!matcher.matches_ancestor(&canonical.join("new-sibling")));
    }

    fn receive_path(rx: &std::sync::mpsc::Receiver<String>, expected: &std::path::Path) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
            match rx.recv_timeout(remaining) {
                Ok(path) if std::path::Path::new(&path) == expected => return,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        panic!("no dependency event for {}", expected.display());
    }

    #[test]
    fn watches_import_created_inside_initially_missing_directories() {
        let root = tempfile::tempdir().unwrap();
        let leaf = root.path().join("new/nested/leaf.typ");
        let state = TypstDepWatcherState::new();
        let (tx, rx) = channel();
        state
            .sync("test".into(), set(&[leaf.to_str().unwrap()]), move |path| {
                let _ = tx.send(path);
            })
            .unwrap();

        // No frontend re-sync: its dependency set has not changed. Creation
        // must itself trigger a compile, including mkdir + write in one burst.
        std::fs::create_dir_all(leaf.parent().unwrap()).unwrap();
        std::fs::write(&leaf, "#let value = [created]\n").unwrap();
        receive_path(&rx, &leaf);
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        std::fs::write(&leaf, "#let value = [changed]\n").unwrap();
        receive_path(&rx, &leaf);
    }

    #[test]
    fn failed_install_preserves_old_watches_and_allows_identical_retry() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old.typ");
        std::fs::write(&old, "old").unwrap();
        // A regular file where a directory is required makes watch() fail
        // deterministically, even when tests run as root.
        let parent = root.path().join("blocked");
        std::fs::write(&parent, "not a directory").unwrap();
        let leaf = parent.join("leaf.typ");
        let state = TypstDepWatcherState::new();
        let (tx, rx) = channel();
        state
            .sync("test".into(), set(&[old.to_str().unwrap()]), move |path| {
                let _ = tx.send(path);
            })
            .unwrap();
        let wanted = set(&[leaf.to_str().unwrap()]);
        assert!(state.sync("test".into(), wanted.clone(), |_| {}).is_err());
        assert_eq!(
            state.inner.lock().unwrap()["test"].paths,
            set(&[old.to_str().unwrap()])
        );
        std::fs::write(&old, "still watched").unwrap();
        receive_path(&rx, &old);

        std::fs::remove_file(&parent).unwrap();
        std::fs::create_dir(&parent).unwrap();
        std::fs::write(&leaf, "created").unwrap();
        let (tx, rx) = channel();
        state
            .sync("test".into(), wanted, move |path| {
                let _ = tx.send(path);
            })
            .unwrap();
        std::fs::write(&leaf, "changed").unwrap();
        receive_path(&rx, &leaf);
    }
}
