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

fn is_ignored(name: &str) -> bool {
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
    let mut out = Vec::new();
    walk_for_markdown(&root_path, &root_path, 0, &mut out)?;
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(out)
}

fn walk_for_markdown(
    root: &std::path::Path,
    current: &std::path::Path,
    depth: u32,
    out: &mut Vec<MarkdownFileEntry>,
) -> Result<(), FileError> {
    if depth > MAX_FOLDER_DEPTH || out.len() >= MAX_FOLDER_ENTRIES {
        return Ok(());
    }
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        // Permission denied / unreadable: silently skip subtree.
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name_owned = entry.file_name();
        let name = name_owned.to_string_lossy();
        if is_ignored(name.as_ref()) {
            continue;
        }
        if path.is_dir() {
            walk_for_markdown(root, &path, depth + 1, out)?;
            if out.len() >= MAX_FOLDER_ENTRIES {
                return Ok(());
            }
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if is_markdown_ext(ext) {
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                out.push(MarkdownFileEntry {
                    path: path.to_string_lossy().to_string(),
                    relative: rel,
                });
            }
        }
    }
    Ok(())
}
