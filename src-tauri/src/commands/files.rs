use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
pub enum FileError {
    #[error("io error: {0}")]
    Io(String),
    #[error("not utf-8: {0}")]
    NotUtf8(String),
    #[error("file too large: {0} bytes")]
    TooLarge(u64),
}

const MAX_BYTES: u64 = 50 * 1024 * 1024;

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, FileError> {
    let pb = PathBuf::from(&path);
    let meta = std::fs::metadata(&pb).map_err(|e| FileError::Io(e.to_string()))?;
    if meta.len() > MAX_BYTES {
        return Err(FileError::TooLarge(meta.len()));
    }
    let bytes = std::fs::read(&pb).map_err(|e| FileError::Io(e.to_string()))?;
    String::from_utf8(bytes).map_err(|e| FileError::NotUtf8(e.to_string()))
}

/// Read a local image file and return its bytes base64-encoded. Used by the
/// reading-mode image widget: relative/absolute image paths can't be assigned
/// to `<img src>` directly (the webview origin is `tauri://localhost`), so the
/// frontend reads them through here and wraps the bytes in an object URL.
#[tauri::command]
pub fn read_image_base64(path: String) -> Result<String, FileError> {
    use base64::Engine;
    let pb = PathBuf::from(&path);
    let meta = std::fs::metadata(&pb).map_err(|e| FileError::Io(e.to_string()))?;
    if meta.len() > MAX_BYTES {
        return Err(FileError::TooLarge(meta.len()));
    }
    let bytes = std::fs::read(&pb).map_err(|e| FileError::Io(e.to_string()))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), FileError> {
    let pb = std::path::PathBuf::from(&path);
    std::fs::write(&pb, contents.as_bytes()).map_err(|e| FileError::Io(e.to_string()))
}

/// Rename a file on disk. Rejects when `to` already exists so the sidebar's
/// inline rename never silently clobbers a sibling — the frontend already
/// pre-checks against the in-memory tree, but we re-check here because the
/// tree can be a few hundred ms behind the watcher. Desktop-only: the mobile
/// shell has no file-tree UI and Android sandboxing makes plain
/// `std::fs::rename` unreliable across SAF URIs.
#[cfg(desktop)]
#[tauri::command]
pub fn rename_file(from: String, to: String) -> Result<(), FileError> {
    let to_path = std::path::PathBuf::from(&to);
    if to_path.exists() {
        return Err(FileError::Io(format!("target already exists: {to}")));
    }
    std::fs::rename(&from, &to).map_err(|e| FileError::Io(e.to_string()))
}

/// Move a file to the OS trash. Falls back to `std::fs::remove_file` if the
/// platform trash call errors — better to lose the file than to leave the
/// user with a sidebar entry they can't delete. The fallback is logged so
/// power users see it; the frontend doesn't surface trash-vs-unlink to the
/// user. Desktop-only for the same reasons as `rename_file`.
#[cfg(desktop)]
#[tauri::command]
pub fn trash_file(path: String) -> Result<(), FileError> {
    match trash::delete(&path) {
        Ok(()) => Ok(()),
        Err(e) => {
            eprintln!("trash failed, falling back to unlink: {e}");
            std::fs::remove_file(&path).map_err(|e| FileError::Io(e.to_string()))
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct RecoveryEntry {
    pub original_path: String,
    pub contents: String,
    pub timestamp_ms: i64,
}

fn recovery_dir(app: &tauri::AppHandle) -> Result<PathBuf, FileError> {
    let app_dir = app.path().app_data_dir().map_err(|e| FileError::Io(e.to_string()))?;
    let dir = app_dir.join("recovery");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| FileError::Io(e.to_string()))?;
    }
    Ok(dir)
}

fn slug_for(path: &str) -> String {
    let mut s = String::with_capacity(path.len());
    for c in path.chars() {
        if c.is_ascii_alphanumeric() { s.push(c); }
        else { s.push('_'); }
    }
    s
}

#[tauri::command]
pub fn write_recovery(
    app: tauri::AppHandle,
    original_path: String,
    contents: String,
) -> Result<(), FileError> {
    let dir = recovery_dir(&app)?;
    let slug = slug_for(&original_path);
    let entry = RecoveryEntry {
        original_path,
        contents,
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
    };
    let json = serde_json::to_vec(&entry).map_err(|e| FileError::Io(e.to_string()))?;
    std::fs::write(dir.join(format!("{}.json", slug)), json)
        .map_err(|e| FileError::Io(e.to_string()))
}

#[tauri::command]
pub fn read_all_recovery(app: tauri::AppHandle) -> Result<Vec<RecoveryEntry>, FileError> {
    let dir = recovery_dir(&app)?;
    let mut out = Vec::new();
    if !dir.exists() { return Ok(out); }
    for entry in std::fs::read_dir(&dir).map_err(|e| FileError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| FileError::Io(e.to_string()))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let bytes = std::fs::read(&path).map_err(|e| FileError::Io(e.to_string()))?;
        if let Ok(rec) = serde_json::from_slice::<RecoveryEntry>(&bytes) {
            out.push(rec);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn clear_recovery(app: tauri::AppHandle, original_path: String) -> Result<(), FileError> {
    let dir = recovery_dir(&app)?;
    let slug = slug_for(&original_path);
    let path = dir.join(format!("{}.json", slug));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| FileError::Io(e.to_string()))?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct DocumentEntry {
    pub path: String,
    pub relative: String,
}

const MAX_FOLDER_DEPTH: u32 = 6;
const MAX_FOLDER_ENTRIES: usize = 5_000;

pub(crate) fn is_ignored(name: &str) -> bool {
    // Explicit list rather than a blanket dot-prefix rule. Many useful
    // doc directories start with a dot (.claude, .github, .config) and
    // hiding them silently was confusing — users opened a folder, saw no
    // files, and didn't know the walker had skipped a subtree on purpose.
    matches!(
        name,
        "node_modules"
            | "dist"
            | "build"
            | "target"
            | "out"
            | "__pycache__"
            | ".git"
            | ".jj"
            | ".hg"
            | ".svn"
            | ".cache"
            | ".next"
            | ".nuxt"
            | ".turbo"
            | ".parcel-cache"
            | ".svelte-kit"
            | ".vercel"
            | ".idea"
            | ".vscode"
            | ".venv"
    )
}

fn is_supported_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "markdown" | "mdx" | "mdown" | "typ"
    )
}

/// Returns true when `path` is a directory that contains a `.git` entry — i.e.
/// a nested git checkout. Same predicate catches:
///   - Git worktrees (`.git` is a file pointing back to the parent repo's
///     `worktrees/<name>` metadata).
///   - Submodules (`.git` is a file or directory).
///
/// A `.git` directory at the *user-opened root* is the project itself and
/// must NOT be excluded — callers handle that case by comparing against the
/// root. This helper just answers the structural question.
pub(crate) fn is_nested_checkout(path: &std::path::Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    path.join(".git").exists()
}

#[tauri::command]
pub fn is_directory(path: String) -> bool {
    std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false)
}

/// Returns true if the path exists at all (file or directory). Used by the
/// multi-window session restore to skip session entries whose file has been
/// deleted/moved between launches without showing an error modal storm.
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    std::fs::metadata(&path).is_ok()
}

/// Resolve the folder a file "belongs to" for sidebar display:
/// the nearest ancestor containing a VCS marker (.git, .jj, .hg, .svn) if any,
/// otherwise the file's immediate parent directory. Returns the input
/// unchanged if it's already a directory, or empty string if no parent exists.
#[tauri::command]
pub fn resolve_folder_root(path: String) -> String {
    let p = std::path::Path::new(&path);
    let start: &std::path::Path = if p.is_dir() {
        p
    } else {
        match p.parent() {
            Some(parent) => parent,
            None => return String::new(),
        }
    };
    const MARKERS: &[&str] = &[".git", ".jj", ".hg", ".svn"];
    let mut cursor = start;
    loop {
        for m in MARKERS {
            if cursor.join(m).exists() {
                return canonicalize_path_str(&cursor.to_string_lossy());
            }
        }
        match cursor.parent() {
            Some(parent) if parent != cursor => cursor = parent,
            _ => break,
        }
    }
    canonicalize_path_str(&start.to_string_lossy())
}

/// Canonicalize a path to a stable, absolute, symlink-resolved string via
/// `std::fs::canonicalize`, so the same folder/file reached by different
/// spellings (relative, `..`, doubled slashes, or through a symlink) collapses
/// to one identity. Falls back to the input unchanged when the path can't be
/// resolved (doesn't exist yet, permission denied), matching the JS
/// `canonicalizePath` contract. This is the single source of truth for path
/// identity — every entry point that records or compares a folder root routes
/// through it so the JS layer never holds a non-canonical path string. See
/// issue #99.
pub(crate) fn canonicalize_path_str(path: &str) -> String {
    std::fs::canonicalize(path)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Frontend-facing wrapper around [`canonicalize_path_str`]. The JS shell calls
/// this before storing or comparing any folder root.
#[tauri::command]
pub fn canonicalize_path(path: String) -> String {
    canonicalize_path_str(&path)
}

/// Reveal a file in the platform's file manager. Highlights the file itself
/// (rather than just opening the parent directory) where the platform
/// supports it. Errors are surfaced as Strings — the command is best-effort
/// so the frontend can decide whether to show a notice.
#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        // /select, highlights the file inside its parent folder.
        Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No standard cross-distro 'select file' command; open the parent
        // directory via xdg-open. The user lands close enough to act.
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        Command::new("xdg-open")
            .arg(parent.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_documents(root: String) -> Result<Vec<DocumentEntry>, FileError> {
    let root_path = PathBuf::from(&root);
    let out = walk_for_documents(&root_path);
    Ok(out)
}

/// Walk `root` collecting supported documents (Markdown + Typst), honoring
/// `.gitignore` (and friends) when the root is inside a Git repo. Uses
/// `ignore::WalkBuilder` — same engine ripgrep uses — so nested ignores,
/// `.git/info/exclude`, and the user's global `core.excludesFile` are all
/// handled.
///
/// In addition to whatever git ignores, `is_ignored()` still applies as a
/// `filter_entry` so non-Git projects (and Git projects that didn't bother to
/// ignore `node_modules` etc.) stay clean. We keep `.hidden(false)` so
/// directories like `.github` and `.claude`, which often hold real documents,
/// remain visible — see the comment on `is_ignored`.
fn walk_for_documents(root: &std::path::Path) -> Vec<DocumentEntry> {
    use ignore::WalkBuilder;

    let root_for_filter = root.to_path_buf();
    let mut builder = WalkBuilder::new(root);
    builder
        .standard_filters(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(true) // only consult .gitignore when inside a Git repo
        .hidden(false)
        .parents(true)
        // ignore::WalkBuilder depth counts the root as 0, so to keep parity
        // with the previous hand-rolled walker (which allowed depth up to and
        // including MAX_FOLDER_DEPTH) we pass MAX_FOLDER_DEPTH directly.
        .max_depth(Some(MAX_FOLDER_DEPTH as usize))
        .filter_entry(move |entry| {
            // Mirror the old explicit-skip list. Apply to every component;
            // WalkBuilder will short-circuit the subtree when this returns
            // false for a directory.
            let name = entry.file_name().to_string_lossy();
            if is_ignored(name.as_ref()) {
                return false;
            }
            // Skip nested git checkouts (worktrees, submodules) — they're
            // structurally separate repos, not "files in this project".
            // The user-opened root is allowed even if it IS a checkout.
            let p = entry.path();
            if p != root_for_filter.as_path() && is_nested_checkout(p) {
                return false;
            }
            true
        });

    let mut out: Vec<DocumentEntry> = Vec::new();
    for result in builder.build() {
        if out.len() >= MAX_FOLDER_ENTRIES {
            break;
        }
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue, // permission denied / broken symlink — skip
        };
        // Skip the root itself, dirs, and non-markdown files.
        let path = entry.path();
        if path == root {
            continue;
        }
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e,
            None => continue,
        };
        if !is_supported_ext(ext) {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        out.push(DocumentEntry {
            path: path.to_string_lossy().to_string(),
            relative: rel,
        });
    }
    // Preserve the previous deterministic order: sort by the relative path.
    // The WalkBuilder traversal isn't ordered the same way as the old
    // hand-rolled walker, so this sort is what keeps snapshot tests stable.
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    out
}

/// Returns true when `path` would be surfaced by `list_documents` from
/// the perspective of ignore filtering — i.e. it isn't in a hard-coded ignore
/// directory and isn't excluded by `.gitignore`/`.git/info/exclude`/global
/// excludes when `root` is inside a Git repo.
///
/// `folder_watcher.rs` calls this to drop fs events for paths the file picker
/// and sidebar would never show, so e.g. a `cargo build` writing into
/// `target/` doesn't churn the project tree.
pub(crate) fn is_path_visible(root: &std::path::Path, path: &std::path::Path) -> bool {
    let rel = match path.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => return true, // outside root — don't claim authority
    };
    // Hardcoded list first: cheap and applies even outside Git repos.
    for component in rel.components() {
        if let std::path::Component::Normal(os) = component {
            if let Some(s) = os.to_str() {
                if is_ignored(s) {
                    return false;
                }
            }
        }
    }
    // Reject paths whose strict ancestor (above `path`, at-or-below `root`)
    // is a nested git checkout. The root itself is allowed even if it is a
    // checkout — that's the project the user opened. Walk top-down from
    // `root` so we stat each intermediate directory at most once.
    {
        let mut cursor = root.to_path_buf();
        for component in rel.components() {
            if let std::path::Component::Normal(os) = component {
                cursor.push(os);
                // Stop before checking `path` itself — only intermediate
                // ancestors disqualify it.
                if cursor.as_path() == path {
                    break;
                }
                if is_nested_checkout(&cursor) {
                    return false;
                }
            }
        }
    }
    // Then ask the same ignore stack `list_documents` uses.
    let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
    // Walk up from `root` looking for the enclosing .git so we know which
    // .gitignore stack applies. ignore::Gitignore handles nested ignores
    // automatically when fed each one.
    let mut found_git = false;
    let mut cursor = Some(root);
    while let Some(dir) = cursor {
        if dir.join(".git").exists() {
            found_git = true;
            break;
        }
        cursor = dir.parent();
    }
    if !found_git {
        return true;
    }
    // Add .gitignore files along the relative path so nested ignores apply.
    let mut walked = root.to_path_buf();
    let _ = builder.add(walked.join(".gitignore"));
    for component in rel.components() {
        if let std::path::Component::Normal(os) = component {
            walked.push(os);
            if walked.is_dir() {
                let _ = builder.add(walked.join(".gitignore"));
            }
        }
    }
    let gi = match builder.build() {
        Ok(g) => g,
        Err(_) => return true,
    };
    let is_dir = path.is_dir();
    !gi.matched_path_or_any_parents(path, is_dir).is_ignore()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn unique_tempdir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "marklig-files-test-{}-{}-{}",
            label,
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create tempdir");
        path
    }

    fn git_init(dir: &Path) {
        // ignore::WalkBuilder treats a directory as a Git repo when it
        // contains `.git` (file or dir). A bare marker file is enough.
        std::fs::create_dir_all(dir.join(".git")).expect("create .git");
        // Some `ignore` codepaths look for HEAD; create a minimal one.
        std::fs::write(dir.join(".git/HEAD"), b"ref: refs/heads/main\n")
            .expect("write HEAD");
    }

    fn relatives(entries: &[DocumentEntry]) -> Vec<String> {
        let mut v: Vec<String> = entries.iter().map(|e| e.relative.replace('\\', "/")).collect();
        v.sort();
        v
    }

    #[test]
    fn gitignore_directory_pattern_excludes_subtree() {
        let root = unique_tempdir("gitignore-dir");
        git_init(&root);
        std::fs::write(root.join(".gitignore"), b"secret/\n").unwrap();
        std::fs::write(root.join("notes.md"), b"# notes\n").unwrap();
        std::fs::write(root.join("top.md"), b"# top\n").unwrap();
        std::fs::create_dir_all(root.join("secret")).unwrap();
        std::fs::write(root.join("secret/leaked.md"), b"# leaked\n").unwrap();

        let got = relatives(&walk_for_documents(&root));
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(got, vec!["notes.md".to_string(), "top.md".to_string()]);
    }

    #[test]
    fn gitignore_glob_pattern_excludes_matching_files() {
        let root = unique_tempdir("gitignore-glob");
        git_init(&root);
        std::fs::write(root.join(".gitignore"), b"*.draft.md\n").unwrap();
        std::fs::write(root.join("ok.md"), b"# ok\n").unwrap();
        std::fs::write(root.join("foo.draft.md"), b"# draft\n").unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/bar.draft.md"), b"# nested draft\n").unwrap();
        std::fs::write(root.join("sub/keep.md"), b"# keep\n").unwrap();

        let got = relatives(&walk_for_documents(&root));
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(got, vec!["ok.md".to_string(), "sub/keep.md".to_string()]);
    }

    #[test]
    fn non_git_root_ignores_gitignore_file() {
        // .gitignore present, but no .git → ignore-crate skips it
        // (require_git(true)). Only the hardcoded set applies.
        let root = unique_tempdir("non-git");
        std::fs::write(root.join(".gitignore"), b"secret/\n").unwrap();
        std::fs::write(root.join("notes.md"), b"# notes\n").unwrap();
        std::fs::create_dir_all(root.join("secret")).unwrap();
        std::fs::write(root.join("secret/leaked.md"), b"# leaked\n").unwrap();

        let got = relatives(&walk_for_documents(&root));
        let _ = std::fs::remove_dir_all(&root);

        // Both files surface; the .gitignore is inert without a Git context.
        assert_eq!(
            got,
            vec!["notes.md".to_string(), "secret/leaked.md".to_string()]
        );
    }

    #[test]
    fn hardcoded_ignores_apply_inside_git_repo() {
        let root = unique_tempdir("git-with-node_modules");
        git_init(&root);
        // No .gitignore — but node_modules should still be skipped because
        // `is_ignored` runs as a `filter_entry`.
        std::fs::write(root.join("readme.md"), b"# readme\n").unwrap();
        std::fs::create_dir_all(root.join("node_modules/foo")).unwrap();
        std::fs::write(root.join("node_modules/foo.md"), b"# pkg\n").unwrap();

        let got = relatives(&walk_for_documents(&root));
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(got, vec!["readme.md".to_string()]);
    }

    #[test]
    fn nested_checkout_with_git_file_is_excluded() {
        // Synthesize a git worktree: `.git` is a FILE.
        let root = unique_tempdir("nested-worktree");
        git_init(&root);
        std::fs::write(root.join("top.md"), b"# top\n").unwrap();
        std::fs::create_dir_all(root.join("wt")).unwrap();
        std::fs::write(
            root.join("wt/.git"),
            b"gitdir: /elsewhere/.git/worktrees/wt\n",
        )
        .unwrap();
        std::fs::write(root.join("wt/inner.md"), b"# inner\n").unwrap();

        let got = relatives(&walk_for_documents(&root));
        let inner_visible = is_path_visible(&root, &root.join("wt/inner.md"));
        let top_visible = is_path_visible(&root, &root.join("top.md"));
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(got, vec!["top.md".to_string()]);
        assert!(!inner_visible, "file inside nested worktree should be hidden");
        assert!(top_visible, "file at root should remain visible");
    }

    #[test]
    fn nested_checkout_with_git_dir_is_excluded() {
        // Synthesize a submodule: `.git` is a DIRECTORY.
        let root = unique_tempdir("nested-submodule");
        git_init(&root);
        std::fs::write(root.join("top.md"), b"# top\n").unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join("sub/.git")).unwrap();
        std::fs::write(root.join("sub/.git/HEAD"), b"ref: refs/heads/main\n").unwrap();
        std::fs::write(root.join("sub/inner.md"), b"# inner\n").unwrap();

        let got = relatives(&walk_for_documents(&root));
        let inner_visible = is_path_visible(&root, &root.join("sub/inner.md"));
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(got, vec!["top.md".to_string()]);
        assert!(!inner_visible, "file inside nested submodule should be hidden");
    }

    #[test]
    fn root_with_dot_git_is_not_excluded_from_itself() {
        // The user-opened root IS a git repo — its own `.md` files and
        // non-nested subdirs must surface. Only the `.git` directory itself
        // is hidden (via `is_ignored`).
        let root = unique_tempdir("root-is-repo");
        git_init(&root);
        std::fs::write(root.join("readme.md"), b"# readme\n").unwrap();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/guide.md"), b"# guide\n").unwrap();

        let got = relatives(&walk_for_documents(&root));
        let readme_visible = is_path_visible(&root, &root.join("readme.md"));
        let guide_visible = is_path_visible(&root, &root.join("docs/guide.md"));
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(
            got,
            vec!["docs/guide.md".to_string(), "readme.md".to_string()]
        );
        assert!(readme_visible);
        assert!(guide_visible);
    }

    #[test]
    fn nested_checkout_and_gitignore_combine() {
        // Two nested checkouts: one inside a gitignored dir (gitignore wins
        // first); one inside a non-ignored dir (the new rule wins). A
        // sibling `.md` outside both is visible.
        let root = unique_tempdir("nested-and-gitignore");
        git_init(&root);
        std::fs::write(root.join(".gitignore"), b"ignored/\n").unwrap();
        std::fs::write(root.join("top.md"), b"# top\n").unwrap();

        // Inside gitignored dir.
        std::fs::create_dir_all(root.join("ignored/wt1")).unwrap();
        std::fs::write(
            root.join("ignored/wt1/.git"),
            b"gitdir: /elsewhere/.git/worktrees/wt1\n",
        )
        .unwrap();
        std::fs::write(root.join("ignored/wt1/inner.md"), b"# inner1\n").unwrap();

        // Inside a non-ignored dir.
        std::fs::create_dir_all(root.join("agents/wt2")).unwrap();
        std::fs::write(
            root.join("agents/wt2/.git"),
            b"gitdir: /elsewhere/.git/worktrees/wt2\n",
        )
        .unwrap();
        std::fs::write(root.join("agents/wt2/inner.md"), b"# inner2\n").unwrap();
        std::fs::write(root.join("agents/sibling.md"), b"# sibling\n").unwrap();

        let got = relatives(&walk_for_documents(&root));
        let v_inner1 = is_path_visible(&root, &root.join("ignored/wt1/inner.md"));
        let v_inner2 = is_path_visible(&root, &root.join("agents/wt2/inner.md"));
        let v_sibling = is_path_visible(&root, &root.join("agents/sibling.md"));
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(
            got,
            vec!["agents/sibling.md".to_string(), "top.md".to_string()]
        );
        assert!(!v_inner1, "gitignore'd nested checkout content hidden");
        assert!(!v_inner2, "non-ignored nested checkout content hidden");
        assert!(v_sibling, "sibling outside the nested checkout is visible");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_dot_git_does_not_crash_walker() {
        // A dangling/odd symlink at `.git` shouldn't panic the walker. The
        // exact filter result isn't asserted — only that we get *some*
        // answer without crashing.
        let root = unique_tempdir("symlink-git");
        git_init(&root);
        std::fs::write(root.join("top.md"), b"# top\n").unwrap();
        std::fs::create_dir_all(root.join("link-wt")).unwrap();
        // Symlink to a non-existent target; .git "exists" only via the link
        // resolving — std::path::Path::exists follows symlinks, so this is
        // effectively a missing target.
        std::os::unix::fs::symlink(
            std::path::Path::new("/nonexistent-marklig-target"),
            root.join("link-wt/.git"),
        )
        .unwrap();
        std::fs::write(root.join("link-wt/inner.md"), b"# inner\n").unwrap();

        // Just ensure neither call panics.
        let _ = walk_for_documents(&root);
        let _ = is_path_visible(&root, &root.join("link-wt/inner.md"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(desktop)]
    #[test]
    fn rename_file_rejects_when_target_exists() {
        let root = unique_tempdir("rename-collision");
        let from = root.join("a.md");
        let to = root.join("b.md");
        std::fs::write(&from, b"# a\n").unwrap();
        std::fs::write(&to, b"# b\n").unwrap();

        let err = rename_file(
            from.to_string_lossy().to_string(),
            to.to_string_lossy().to_string(),
        )
        .expect_err("rename onto existing file should error");
        match err {
            FileError::Io(msg) => assert!(msg.contains("target already exists")),
            other => panic!("unexpected error variant: {other:?}"),
        }
        // Both files still on disk — no destructive side effect.
        assert!(from.exists());
        assert!(to.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(desktop)]
    #[test]
    fn rename_file_moves_source_to_target() {
        let root = unique_tempdir("rename-ok");
        let from = root.join("old.md");
        let to = root.join("new.md");
        std::fs::write(&from, b"# old\n").unwrap();

        rename_file(
            from.to_string_lossy().to_string(),
            to.to_string_lossy().to_string(),
        )
        .expect("rename should succeed");

        assert!(!from.exists(), "old path should be gone");
        assert!(to.exists(), "new path should be present");
        let contents = std::fs::read_to_string(&to).unwrap();
        assert_eq!(contents, "# old\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(desktop)]
    #[test]
    fn trash_file_removes_existing_file() {
        // On CI runners the `trash` crate may or may not be wired up to a
        // working backend; we don't care which branch fires. After the call
        // returns Ok, the file must be gone (either trashed or unlinked).
        let root = unique_tempdir("trash-ok");
        let p = root.join("gone.md");
        std::fs::write(&p, b"# gone\n").unwrap();

        trash_file(p.to_string_lossy().to_string()).expect("trash or unlink should succeed");
        assert!(!p.exists(), "file should no longer exist on the original path");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(desktop)]
    #[test]
    fn trash_file_errors_for_missing_path() {
        // Exercise the fallback path: a non-existent path produces a trash
        // error, the fallback `remove_file` then also errors, and that's the
        // FileError we surface to the frontend.
        let root = unique_tempdir("trash-missing");
        let p = root.join("does-not-exist.md");

        let err = trash_file(p.to_string_lossy().to_string())
            .expect_err("trashing a missing path should error");
        match err {
            FileError::Io(_) => {}
            other => panic!("unexpected error variant: {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn is_path_visible_respects_gitignore_and_hardcoded() {
        let root = unique_tempdir("visible");
        git_init(&root);
        std::fs::write(root.join(".gitignore"), b"secret/\n").unwrap();
        std::fs::create_dir_all(root.join("secret")).unwrap();
        std::fs::write(root.join("secret/leaked.md"), b"# leaked\n").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/foo.md"), b"# pkg\n").unwrap();
        std::fs::write(root.join("notes.md"), b"# notes\n").unwrap();

        let hidden_by_git = root.join("secret/leaked.md");
        let hidden_by_hardcoded = root.join("node_modules/foo.md");
        let visible = root.join("notes.md");

        let h1 = is_path_visible(&root, &hidden_by_git);
        let h2 = is_path_visible(&root, &hidden_by_hardcoded);
        let v = is_path_visible(&root, &visible);
        let _ = std::fs::remove_dir_all(&root);

        assert!(!h1, ".gitignore'd path should be hidden");
        assert!(!h2, "hardcoded-ignored path should be hidden");
        assert!(v, "tracked file should be visible");
    }

    // Builds its fixture with `std::os::unix::fs::symlink`, so the test
    // target did not compile at all on Windows until this guard. Same
    // convention as the other symlink tests in this tree.
    #[cfg(unix)]
    #[test]
    fn canonicalize_path_str_resolves_symlinked_dir() {
        let base = unique_tempdir("canon-str");
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let got = canonicalize_path_str(&link.to_string_lossy());
        let want = std::fs::canonicalize(&real)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let _ = std::fs::remove_dir_all(&base);

        assert_eq!(got, want, "a symlinked spelling should resolve to the real path");
    }

    #[test]
    fn canonicalize_path_str_falls_back_for_nonexistent() {
        // A path that doesn't exist on disk can't be canonicalized; the
        // contract is to return the input unchanged rather than error.
        let p = "/marklig/no/such/path/zzz";
        assert_eq!(canonicalize_path_str(p), p);
    }

    // Builds its fixture with `std::os::unix::fs::symlink`, so the test
    // target did not compile at all on Windows until this guard. Same
    // convention as the other symlink tests in this tree.
    #[cfg(unix)]
    #[test]
    fn resolve_folder_root_canonicalizes_symlinked_vcs_root() {
        // Opening a folder via a symlinked spelling (e.g. `~/proj` where
        // `proj` is a symlink) must yield the same canonical string as
        // opening it via its real path — otherwise the same project hashes
        // to two different identities. See issue #99.
        let base = unique_tempdir("canon-root");
        let real = base.join("realproj");
        std::fs::create_dir_all(&real).unwrap();
        git_init(&real);
        let link = base.join("linkproj");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let got = resolve_folder_root(link.to_string_lossy().to_string());
        let want = std::fs::canonicalize(&real)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let _ = std::fs::remove_dir_all(&base);

        assert_eq!(got, want, "symlinked folder root should canonicalize to the real path");
    }
}
