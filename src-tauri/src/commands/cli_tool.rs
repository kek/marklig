// Install a `md` shell script under /usr/local/bin so the user can launch
// Märklig from the terminal. macOS-only: the install path needs admin
// privileges, which we get via `osascript … with administrator privileges`.
//
// The script resolves arguments to absolute paths before handing them to
// `open -a <bundle>`. Without that, `open` resolves relative paths against the
// LaunchServices process cwd (usually /), not the shell's cwd, so a plain
// `md readme.md` would silently fail.
//
// The bundle is targeted by absolute path (baked in at install time from
// std::env::current_exe()), not by display name. `open -a "Märklig"` resolves
// by name through LaunchServices, and when more than one bundle with the same
// name is registered (a /Applications copy, a stale DMG entry, a dev build
// under target/release/…), LS can pick a different bundle than Spotlight just
// launched — producing two Dock icons for the "same" app (issue #42).

#[cfg(target_os = "macos")]
const CLI_INSTALL_PATH: &str = "/usr/local/bin/md";

#[cfg(target_os = "macos")]
fn render_cli_script(bundle_path: &str) -> String {
    format!(
        r#"#!/bin/bash
# Märklig command-line launcher.
# Resolves each arg to an absolute path. macOS `open` refuses to launch an
# app when handed a non-existent file argument ("The file ... does not
# exist."), so for Markdown extensions whose parent directory exists we
# `touch` the file first; `open` then sees an existing (empty) file and
# launches the app normally. Non-Markdown paths and paths whose parent
# directory doesn't resolve are forwarded as-is and may still trigger the
# `open` error — we don't want to materialise stray files for typos.
BUNDLE={bundle}
args=()
for arg in "$@"; do
  dir="$(cd "$(dirname "$arg")" 2>/dev/null && pwd)"
  if [ -n "$dir" ]; then
    abs="$dir/$(basename "$arg")"
    if [ ! -e "$abs" ]; then
      lower="$(printf '%s' "$abs" | tr '[:upper:]' '[:lower:]')"
      case "$lower" in
        *.md|*.markdown|*.mdx|*.mdown)
          touch "$abs" 2>/dev/null
          ;;
      esac
    fi
    args+=("$abs")
  fi
done
if [ ${{#args[@]}} -eq 0 ]; then
  exec open -a "$BUNDLE"
else
  exec open -a "$BUNDLE" "${{args[@]}}"
fi
"#,
        bundle = shell_quote(bundle_path),
    )
}

/// Resolve the running app's `.app` bundle from the executable path.
/// `current_exe()` is `.../Märklig.app/Contents/MacOS/marklig`; the bundle is
/// three levels up. Returns an error if the layout doesn't match (e.g. running
/// the raw binary outside a bundle during development) — in that case the
/// install would bake a non-bundle path and `open -a` would fail later, so we
/// fail loudly now instead.
#[cfg(target_os = "macos")]
fn resolve_app_bundle() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let bundle = exe
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| "executable is not inside a .app bundle".to_string())?;
    if bundle.extension().and_then(|s| s.to_str()) != Some("app") {
        return Err(format!(
            "expected .app bundle, got {}",
            bundle.display()
        ));
    }
    Ok(bundle.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn install_cli_tool() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use std::env;
        use std::fs;
        use std::process::Command;

        let bundle_path = resolve_app_bundle()?;
        let script = render_cli_script(&bundle_path);

        // Stage the script in a temp file so the privileged shell step is just
        // a mv/chmod — keeping the elevated command short reduces escaping risk.
        let staged = env::temp_dir().join("marklig-md-install.sh");
        fs::write(&staged, &script).map_err(|e| format!("write staged script: {e}"))?;

        let staged_str = staged.to_string_lossy().to_string();
        let shell_cmd = format!(
            "/bin/mkdir -p /usr/local/bin && /bin/mv {staged} {target} && /bin/chmod 755 {target}",
            staged = shell_quote(&staged_str),
            target = shell_quote(CLI_INSTALL_PATH),
        );

        let apple_script = format!(
            "do shell script \"{}\" with administrator privileges",
            apple_quote(&shell_cmd),
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&apple_script)
            .output()
            .map_err(|e| format!("spawn osascript: {e}"))?;

        if !output.status.success() {
            let _ = fs::remove_file(&staged);
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("-128") || stderr.to_lowercase().contains("user canceled") {
                return Err("cancelled".to_string());
            }
            return Err(stderr.trim().to_string());
        }

        Ok(CLI_INSTALL_PATH.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("CLI tool installation is only supported on macOS".to_string())
    }
}

#[cfg(target_os = "macos")]
fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

#[cfg(target_os = "macos")]
fn apple_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn rendered_script_targets_the_bundle_by_absolute_path() {
        let script = render_cli_script("/Applications/Märklig.app");
        assert!(script.contains("BUNDLE='/Applications/Märklig.app'"));
        assert!(script.contains(r#"exec open -a "$BUNDLE""#));
        // Resolves arg paths to absolute before forwarding to open.
        assert!(script.contains(r#"dir="$(cd "$(dirname "$arg")" 2>/dev/null && pwd)""#));
        // No name-based resolution that LaunchServices could disambiguate
        // against the wrong bundle (issue #42).
        assert!(!script.contains(r#"open -a "Märklig""#));
    }

    #[test]
    fn rendered_script_shell_quotes_a_bundle_path_with_apostrophes() {
        // Won't happen for the default install, but defend the template
        // against unusual install locations.
        let script = render_cli_script("/Users/o'mara/Apps/Märklig.app");
        assert!(script.contains(r#"BUNDLE='/Users/o'\''mara/Apps/Märklig.app'"#));
    }

    #[test]
    fn rendered_script_forwards_nonexistent_paths() {
        // `md newfile.md` should hand the would-be absolute path to `open`
        // so the app can open a fresh editor buffer pointing at it. The old
        // [ -e "$arg" ] guard silently dropped non-existent paths.
        let script = render_cli_script("/Applications/Märklig.app");
        assert!(!script.contains(r#"[ -e "$arg" ]"#));
    }

    #[test]
    fn rendered_script_checks_markdown_extensions_case_insensitively() {
        // `open` errors out on non-existent file args, so for Markdown paths
        // we touch the file before forwarding. The set must match the Rust
        // `is_markdown_ext` helper in commands/files.rs.
        let script = render_cli_script("/Applications/Märklig.app");
        assert!(
            script.contains("*.md|*.markdown|*.mdx|*.mdown"),
            "expected Markdown-extension case glob, got:\n{script}"
        );
        // Case-insensitive comparison so `Foo.MD` still matches.
        assert!(script.contains("tr '[:upper:]' '[:lower:]'"));
    }

    #[test]
    fn rendered_script_touches_only_when_missing_and_parent_resolved() {
        let script = render_cli_script("/Applications/Märklig.app");
        // Only touch if the absolute path does not already exist —
        // we must not bump mtime on existing files.
        assert!(script.contains(r#"if [ ! -e "$abs" ]"#));
        // The touch is reached inside the `if [ -n "$dir" ]` branch, so
        // it only runs when the parent directory resolved successfully.
        let dir_idx = script
            .find(r#"if [ -n "$dir" ]"#)
            .expect("dir-resolved guard present");
        let touch_idx = script.find("touch \"$abs\"").expect("touch present");
        assert!(touch_idx > dir_idx, "touch must live inside the dir guard");
    }

    #[test]
    fn rendered_script_never_creates_directories() {
        // `md typo/typo/foo.md` should fail loudly via `open`, not silently
        // materialise two stray directories.
        let script = render_cli_script("/Applications/Märklig.app");
        assert!(!script.contains("mkdir"));
    }

    #[test]
    fn rendered_script_still_forwards_to_open_with_resolved_paths() {
        let script = render_cli_script("/Applications/Märklig.app");
        // Both branches (no args, args) still exec `open -a "$BUNDLE"`.
        assert!(script.contains(r#"exec open -a "$BUNDLE""#));
        assert!(script.contains(r#"exec open -a "$BUNDLE" "${args[@]}""#));
        // Bundle is interpolated at install time, not resolved by name.
        assert!(script.contains("BUNDLE='/Applications/Märklig.app'"));
        // The resolved absolute path (existing OR newly-touched) is what
        // gets appended to args.
        assert!(script.contains(r#"args+=("$abs")"#));
    }
}
