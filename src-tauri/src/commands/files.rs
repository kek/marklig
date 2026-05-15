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

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), FileError> {
    let pb = std::path::PathBuf::from(&path);
    std::fs::write(&pb, contents.as_bytes()).map_err(|e| FileError::Io(e.to_string()))
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
pub struct MarkdownFileEntry {
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

fn is_markdown_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "markdown" | "mdx" | "mdown"
    )
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
                return cursor.to_string_lossy().to_string();
            }
        }
        match cursor.parent() {
            Some(parent) if parent != cursor => cursor = parent,
            _ => break,
        }
    }
    start.to_string_lossy().to_string()
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
pub fn list_markdown_files(root: String) -> Result<Vec<MarkdownFileEntry>, FileError> {
    let root_path = PathBuf::from(&root);
    let out = walk_for_markdown(&root_path);
    Ok(out)
}

/// Walk `root` collecting markdown files, honoring `.gitignore` (and friends)
/// when the root is inside a Git repo. Uses `ignore::WalkBuilder` — same
/// engine ripgrep uses — so nested ignores, `.git/info/exclude`, and the
/// user's global `core.excludesFile` are all handled.
///
/// In addition to whatever git ignores, `is_ignored()` still applies as a
/// `filter_entry` so non-Git projects (and Git projects that didn't bother to
/// ignore `node_modules` etc.) stay clean. We keep `.hidden(false)` so
/// directories like `.github` and `.claude`, which often hold real Markdown,
/// remain visible — see the comment on `is_ignored`.
fn walk_for_markdown(root: &std::path::Path) -> Vec<MarkdownFileEntry> {
    use ignore::WalkBuilder;

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
        .filter_entry(|entry| {
            // Mirror the old explicit-skip list. Apply to every component;
            // WalkBuilder will short-circuit the subtree when this returns
            // false for a directory.
            let name = entry.file_name().to_string_lossy();
            !is_ignored(name.as_ref())
        });

    let mut out: Vec<MarkdownFileEntry> = Vec::new();
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
        if !is_markdown_ext(ext) {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        out.push(MarkdownFileEntry {
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

    fn relatives(entries: &[MarkdownFileEntry]) -> Vec<String> {
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

        let got = relatives(&walk_for_markdown(&root));
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

        let got = relatives(&walk_for_markdown(&root));
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

        let got = relatives(&walk_for_markdown(&root));
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

        let got = relatives(&walk_for_markdown(&root));
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(got, vec!["readme.md".to_string()]);
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
}

/// Returns true when `path` would be surfaced by `list_markdown_files` from
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
    // Then ask the same ignore stack `list_markdown_files` uses.
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
