use notify::{EventKind, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebouncedEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Window};

#[derive(Debug, Serialize, Clone)]
pub struct WatcherEvent {
    pub kind: WatcherEventKind,
    pub path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "kebab-case")]
pub enum WatcherEventKind {
    Modified,
    Removed,
}

/// Per-window watcher map. Each viewer window owns at most one active watcher
/// (for its current file). Keying by window.label() means File -> New Window
/// can edit a different file with its own watcher and reconciliation flow,
/// instead of stomping the previous window's watcher state.
pub struct WatcherState {
    inner: Mutex<HashMap<String, WatcherInner>>,
}

struct WatcherInner {
    /// Kept for diagnostic/tracing purposes — surfaced via the optional
    /// debug command and also used as the source of truth for what the
    /// watcher is currently watching when reconciling state.
    #[allow(dead_code)]
    target: PathBuf,
    self_write_ts: Option<Instant>,
    _debouncer:
        notify_debouncer_full::Debouncer<notify::RecommendedWatcher, notify_debouncer_full::FileIdMap>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

const SELF_WRITE_WINDOW: Duration = Duration::from_millis(500);

/// The path spellings an incoming watcher event may use for our target.
///
/// `notify` does not normalise the paths it reports, and its two Unix backends
/// disagree about which spelling they use for the same file:
///
/// * macOS FSEvents reports **canonical** paths, symlinks resolved. A file
///   watched as `/tmp/x/file.md` comes back as `/private/tmp/x/file.md`.
/// * Linux inotify reports the path **as it was watched**, joined with the
///   changed directory entry's name. The same file comes back as
///   `/tmp/x/file.md`.
///
/// So there is no single spelling to compare against, and picking either one
/// drops every event on the other platform. Picking the canonical one is what
/// issue #47 was: on Linux, an external edit to a file opened through a
/// symlinked path never reached the frontend, so a clean buffer never
/// auto-reloaded.
///
/// This holds **both** spellings, each computed once at watch time, and matches
/// an event if it equals either. The alternatives and why they lose:
///
/// * *Canonicalize every event path instead.* One `stat`-chain syscall per
///   event on the notify callback thread, and — the real defect —
///   `canonicalize` fails on a path that no longer exists, which is precisely
///   the case for `EventKind::Remove`. Removal is one of the two event kinds
///   this watcher emits, so that trade buys symlink correctness by breaking
///   deletion detection.
/// * *Canonicalize only when the verbatim comparison fails.* This sounds like
///   paying on the cold path, but the watch is `NonRecursive` on the target's
///   **parent directory**, so every event for every sibling file arrives here
///   and misses. While a file is being edited, misses dominate: editors emit
///   events for `.file.md.swp`, `file.md~`, `.#file.md` and atomic-save temp
///   files, most of which are already unlinked by the time we would look at
///   them — a syscall per event, that also fails. The miss path *is* the hot
///   path.
///
/// The cost here is one extra `PathBuf` per active watcher (one per window)
/// and one extra `canonicalize` at watch time. Nothing per event.
///
/// Known limit, deliberately not addressed: if the symlink is retargeted while
/// the watch is live, `canonical` goes stale. That cannot be fixed here,
/// because the kernel watch is stale too — `inotify_add_watch` resolves the
/// path to an inode once, and the watch follows that inode, not the name, so
/// no events for the new target are ever delivered no matter what we compare
/// against. Events keep arriving spelled as the watch path, `verbatim` keeps
/// matching them, and we keep reporting changes to the old file: unchanged
/// pre-existing behaviour, and no panic or dropped watch. Re-establishing the
/// watch when a link's target moves is a separate change.
struct TargetMatcher {
    /// The path exactly as the frontend asked us to watch it.
    verbatim: PathBuf,
    /// The fully-resolved path, when it could be resolved and differs.
    canonical: Option<PathBuf>,
}

impl TargetMatcher {
    fn new(target: &std::path::Path) -> Self {
        let verbatim = target.to_path_buf();
        // Resolve the target itself when it exists. When it doesn't — a path
        // the frontend has opened but that isn't on disk yet — resolve the
        // *parent* (which does exist, since we're about to watch it) and
        // re-join the file name, so we still know the spelling FSEvents will
        // use once the file appears. Previously this case fell back to the
        // verbatim path alone and so was broken on macOS.
        let canonical = target.canonicalize().ok().or_else(|| {
            let resolved_parent = target.parent()?.canonicalize().ok()?;
            Some(resolved_parent.join(target.file_name()?))
        });
        let canonical = canonical.filter(|c| c != &verbatim);
        Self {
            verbatim,
            canonical,
        }
    }

    fn matches(&self, path: &std::path::Path) -> bool {
        path == self.verbatim || self.canonical.as_deref() == Some(path)
    }

    /// A `notify` event carries one or more paths (two, for renames). It
    /// concerns us if any of them is our target.
    fn matches_any(&self, paths: &[PathBuf]) -> bool {
        paths.iter().any(|p| self.matches(p))
    }
}

#[tauri::command]
pub fn watcher_start(
    app: AppHandle,
    window: Window,
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| "no parent directory".to_string())?
        .to_path_buf();
    let matcher = TargetMatcher::new(&target);
    // Path reported back to the frontend is the *original* (un-canonicalized)
    // path so it matches the value the frontend asked us to watch — callers
    // that compare against `currentPath` shouldn't suddenly see `/private/tmp`
    // when they handed us `/tmp`.
    let report_path = target.to_string_lossy().to_string();
    let label = window.label().to_string();
    let app_for_handler = app.clone();
    let label_for_handler = label.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(150),
        None,
        move |result: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
            let events = match result {
                Ok(ev) => ev,
                Err(_) => return,
            };
            for ev in events {
                let touches_target = matcher.matches_any(&ev.paths);
                if !touches_target {
                    continue;
                }
                let kind = match ev.kind {
                    EventKind::Remove(_) => WatcherEventKind::Removed,
                    _ => WatcherEventKind::Modified,
                };
                // Target the originating window only — broadcasting would let
                // window A react to window B's file-change events.
                let _ = app_for_handler.emit_to(
                    label_for_handler.as_str(),
                    "viewer://file-changed",
                    WatcherEvent {
                        kind,
                        path: report_path.clone(),
                    },
                );
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    // Drop any prior watcher for this window; the debouncer is held in a
    // box and dropping it cancels the underlying notify::Watcher.
    guard.insert(
        label,
        WatcherInner {
            target,
            self_write_ts: None,
            _debouncer: debouncer,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn watcher_stop(
    window: Window,
    state: tauri::State<'_, WatcherState>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    guard.remove(window.label());
    Ok(())
}

#[tauri::command]
pub fn watcher_mark_self_write(
    window: Window,
    state: tauri::State<'_, WatcherState>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(inner) = guard.get_mut(window.label()) {
        inner.self_write_ts = Some(Instant::now());
    }
    Ok(())
}

#[allow(dead_code)]
fn _is_within_self_write_window(ts: Option<Instant>) -> bool {
    match ts {
        Some(t) => Instant::now().duration_since(t) < SELF_WRITE_WINDOW,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Both are used only by the symlink regression test below, which is
    // `#[cfg(unix)]`. The other tests in here drive `TargetMatcher` directly.
    #[cfg(unix)]
    use std::io::Write;
    #[cfg(unix)]
    use std::sync::mpsc::channel;

    /// End-to-end regression for issue #47: when a watched path traverses a
    /// symlink (the common case on macOS where `/tmp` → `/private/tmp`), the
    /// raw input path differs from the canonical path that notify reports back
    /// for fs events. The pre-fix code compared the two directly and silently
    /// dropped every event, so external edits never reached the frontend and
    /// the clean buffer never auto-reloaded.
    ///
    /// This was `cfg_attr(target_os = "linux", ignore)` with the diagnosis in
    /// the attribute: `canonical_match_path` canonicalized the *target* once
    /// and then compared incoming event paths to it verbatim. macOS FSEvents
    /// hands back already-canonical paths so the comparison held, which is why
    /// this always passed locally; Linux inotify hands back the path as it was
    /// watched, so on Linux the first CI run to execute this test reported
    ///     no event matched canonical target; saw events:
    ///     [["/tmp/marklig-watcher-test-14478/link/file.md"], [...]]
    /// The ignore is gone: a skipped test does not report a bug, and this one
    /// must fail on Linux until the watcher matches both spellings.
    ///
    /// Unix-only, because the fixture is a real symlink. This used to be an
    /// in-body `#[cfg(not(unix))] { return; }`, which made every statement
    /// after it unreachable on Windows — the tree's only `unreachable_code`
    /// warning, and one that appeared on no other platform. Gating the test
    /// says the same thing without compiling a body that cannot run.
    #[cfg(unix)]
    #[test]
    fn touches_target_matches_canonical_event_paths_through_symlinks() {
        // Build: <tmpdir>/real/file.md, then <tmpdir>/link → real/.
        // Watching <tmpdir>/link/file.md must match events that come back as
        // <tmpdir>/real/file.md (since notify canonicalizes).
        let root = std::env::temp_dir().join(format!(
            "marklig-watcher-test-{}",
            std::process::id()
        ));
        let real = root.join("real");
        std::fs::create_dir_all(&real).expect("create real dir");
        let real_file = real.join("file.md");
        std::fs::write(&real_file, "# initial\n").expect("seed file");

        let link = root.join("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).expect("create symlink");

        let through_link = link.join("file.md");
        let matcher = TargetMatcher::new(&through_link);

        // Sanity-check the symlink fixture: the canonical form of the path
        // through the link must point at the real file. If not, the platform
        // resolved symlinks early (some CI sandboxes do) and the test isn't
        // exercising the bug — skip rather than report a false pass.
        let real_canonical = real_file.canonicalize().expect("canon real_file");
        if through_link == real_canonical {
            eprintln!("skipping: symlink path is already canonical on this platform");
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        // Now wire up an actual debouncer the same way watcher_start does, and
        // confirm events delivered for an external append match our handler's
        // path comparison.
        let parent = through_link.parent().unwrap().to_path_buf();
        let (tx, rx) = channel();
        let mut debouncer = new_debouncer(
            Duration::from_millis(100),
            None,
            move |result: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
                if let Ok(events) = result {
                    for ev in events {
                        // Deliberately the production predicate, not a copy of
                        // it: a test that re-implements the comparison it is
                        // meant to be pinning cannot fail when the real
                        // comparison is wrong, which is how #47 survived.
                        let matched = matcher.matches_any(&ev.paths);
                        let _ = tx.send((matched, ev.paths.clone()));
                    }
                }
            },
        )
        .expect("debouncer");
        debouncer
            .watcher()
            .watch(&parent, RecursiveMode::NonRecursive)
            .expect("watch");

        // Append externally.
        std::thread::sleep(Duration::from_millis(150));
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&real_file)
            .expect("open append");
        writeln!(f, "external edit").expect("append");
        drop(f);

        // Look for at least one event that matches our path comparison.
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut matched_any = false;
        let mut saw_events = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok((matched, paths)) => {
                    saw_events.push(paths.clone());
                    if matched {
                        matched_any = true;
                        break;
                    }
                }
                Err(_) => continue,
            }
        }

        // Clean up before asserting, so a failure doesn't leak fixture state.
        drop(debouncer);
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            matched_any,
            "no event matched the watch target; saw events: {:?}",
            saw_events
        );
    }

    /// The two spellings, without touching a watcher. Runs everywhere,
    /// including Windows, where the symlink test above bails out — before this
    /// there was no coverage of the path comparison on that platform at all.
    #[test]
    fn matcher_accepts_both_the_watched_and_the_canonical_spelling() {
        let root = std::env::temp_dir().join(format!(
            "marklig-matcher-test-{}",
            std::process::id()
        ));
        let real = root.join("real");
        std::fs::create_dir_all(&real).expect("create real dir");
        let real_file = real.join("file.md");
        std::fs::write(&real_file, "# initial\n").expect("seed file");

        let canonical = real_file.canonicalize().expect("canonicalize");
        let matcher = TargetMatcher::new(&real_file);

        assert!(matcher.matches(&real_file), "must match the path as watched");
        assert!(matcher.matches(&canonical), "must match the canonical path");
        assert!(
            !matcher.matches(&real.join("other.md")),
            "must not match an unrelated sibling"
        );
        assert!(
            matcher.matches_any(&[real.join("other.md"), real_file.clone()]),
            "a multi-path event (e.g. a rename) matches if any path is ours"
        );
        assert!(!matcher.matches_any(&[]), "no paths cannot match");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A target that isn't on disk yet still gets a canonical spelling, via its
    /// parent. `canonicalize` on the file itself fails here, and falling back to
    /// the verbatim path alone — what the code did before — means macOS, which
    /// only ever reports canonical paths, would miss the file's creation.
    #[test]
    fn matcher_resolves_a_target_that_does_not_exist_yet_via_its_parent() {
        let root = std::env::temp_dir().join(format!(
            "marklig-matcher-missing-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("create root");

        let absent = root.join("not-created-yet.md");
        assert!(!absent.exists(), "fixture must not exist");

        let matcher = TargetMatcher::new(&absent);
        let expected = root.canonicalize().expect("canonicalize root").join("not-created-yet.md");

        assert!(matcher.matches(&absent), "must match the path as watched");
        assert!(
            matcher.matches(&expected),
            "must match the canonical spelling the file will have, got {:?}",
            matcher.canonical
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Neither the parent nor the target resolves. The matcher must degrade to
    /// comparing the verbatim path — not panic, and not stop matching.
    #[test]
    fn matcher_degrades_to_verbatim_when_nothing_resolves() {
        let nowhere = std::path::Path::new("/marklig-no-such-root-9d3f/sub/file.md");
        let matcher = TargetMatcher::new(nowhere);

        assert_eq!(matcher.canonical, None);
        assert!(matcher.matches(nowhere));
        assert!(!matcher.matches(std::path::Path::new("/marklig-no-such-root-9d3f/sub/other.md")));
    }
}
