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
//! Watching each file directly would miss the atomic-save pattern most editors
//! use, where the file is replaced rather than written in place.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
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
fn watch_plan(
    paths: &BTreeSet<String>,
) -> (Vec<(String, TargetMatcher)>, BTreeSet<PathBuf>) {
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
    let wanted: BTreeSet<String> = paths.into_iter().collect();

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;

    if wanted.is_empty() {
        guard.remove(&label);
        return Ok(());
    }
    if guard.get(&label).is_some_and(|w| w.paths == wanted) {
        return Ok(());
    }

    let (matchers, parents) = watch_plan(&wanted);

    let app_for_handler = app.clone();
    let label_for_handler = label.clone();

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
                let Some((path, _)) =
                    matchers.iter().find(|(_, m)| m.matches_any(&ev.paths))
                else {
                    continue;
                };
                let _ = app_for_handler.emit_to(
                    label_for_handler.as_str(),
                    "viewer://typst-dependency-changed",
                    DependencyChangedEvent { path: path.clone() },
                );
            }
        },
    )
    .map_err(|e| e.to_string())?;

    for dir in &parents {
        // A directory that cannot be watched (deleted out from under us, or a
        // permission problem) must not sink the whole set — the other
        // dependencies are still worth watching.
        if let Err(err) = debouncer.watcher().watch(dir, RecursiveMode::NonRecursive) {
            eprintln!("typst dep watch failed for {}: {err}", dir.display());
        }
    }

    // Replacing the entry drops the previous debouncer, which cancels its
    // underlying notify watcher.
    guard.insert(
        label,
        DepWatcher {
            paths: wanted,
            _debouncer: debouncer,
        },
    );
    Ok(())
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
    use std::io::Write;
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

    /// The end-to-end question this module exists to answer: when an import
    /// living in a *subdirectory* of the entry file's directory is edited,
    /// does the OS actually hand us an event, and does the production
    /// predicate match it?
    ///
    /// The document watcher only ever watches one directory, so nothing in the
    /// tree covered the multi-directory case before this. Driving a real
    /// debouncer rather than asserting on `watch_plan`'s return value is the
    /// point — the bug worth catching here is a watch that is never armed, and
    /// only the filesystem can report that.
    #[test]
    fn delivers_an_event_for_an_import_in_a_subdirectory() {
        let root = std::env::temp_dir()
            .join(format!("marklig-typst-dep-{}", std::process::id()));
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).expect("create dirs");
        let entry = root.join("main.typ");
        let leaf = sub.join("level2.typ");
        let unrelated = sub.join("notes.txt");
        std::fs::write(&entry, "#import \"sub/level2.typ\": two\n").expect("seed entry");
        std::fs::write(&leaf, "#let two = [ORIGINAL]\n").expect("seed leaf");
        std::fs::write(&unrelated, "not a dependency\n").expect("seed unrelated");

        let wanted = set(&[leaf.to_str().unwrap()]);
        let (matchers, parents) = watch_plan(&wanted);

        let (tx, rx) = channel();
        let mut debouncer = new_debouncer(
            Duration::from_millis(100),
            None,
            move |result: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
                let Ok(events) = result else { return };
                for ev in events {
                    // The production predicate, not a copy of it — a test that
                    // reimplements the comparison it pins cannot fail when the
                    // real comparison is wrong.
                    let hit = matchers
                        .iter()
                        .find(|(_, m)| m.matches_any(&ev.paths))
                        .map(|(p, _)| p.clone());
                    let _ = tx.send((hit, ev.paths.clone()));
                }
            },
        )
        .expect("debouncer");
        for dir in &parents {
            debouncer
                .watcher()
                .watch(dir, RecursiveMode::NonRecursive)
                .expect("watch");
        }

        std::thread::sleep(Duration::from_millis(150));
        // Touch a sibling that is NOT a dependency first. Its events must
        // arrive (we watch the whole directory) and must not match.
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&unrelated)
            .expect("open unrelated");
        writeln!(f, "still not a dependency").expect("append unrelated");
        drop(f);

        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&leaf)
            .expect("open leaf");
        writeln!(f, "#let three = [CHANGED]").expect("append leaf");
        drop(f);

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut matched_leaf = false;
        let mut saw_unrelated_match = false;
        let mut seen: Vec<Vec<PathBuf>> = Vec::new();
        while std::time::Instant::now() < deadline {
            let remaining = deadline - std::time::Instant::now();
            match rx.recv_timeout(remaining) {
                Ok((hit, paths)) => {
                    seen.push(paths.clone());
                    match hit {
                        Some(p) if p == leaf.to_str().unwrap() => matched_leaf = true,
                        Some(_) => saw_unrelated_match = true,
                        None => {}
                    }
                    if matched_leaf {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            matched_leaf,
            "no event matched the subdirectory import; saw events: {seen:?}",
        );
        assert!(
            !saw_unrelated_match,
            "a non-dependency in the same directory was reported as one: {seen:?}",
        );
    }
}
