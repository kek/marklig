// Install a `md` shell script under /usr/local/bin so the user can launch
// Märklig from the terminal. macOS-only: the install path needs admin
// privileges, which we get via `osascript … with administrator privileges`.
//
// The script resolves arguments to absolute paths before handing them to
// `open -a Märklig`. Without that, `open` resolves relative paths against the
// LaunchServices process cwd (usually /), not the shell's cwd, so a plain
// `md readme.md` would silently fail.

#[cfg(target_os = "macos")]
const CLI_INSTALL_PATH: &str = "/usr/local/bin/md";

#[cfg(target_os = "macos")]
const CLI_SCRIPT: &str = r#"#!/bin/bash
# Märklig command-line launcher.
args=()
for arg in "$@"; do
  if [ -e "$arg" ]; then
    dir="$(cd "$(dirname "$arg")" 2>/dev/null && pwd)"
    if [ -n "$dir" ]; then
      args+=("$dir/$(basename "$arg")")
    fi
  fi
done
if [ ${#args[@]} -eq 0 ]; then
  exec open -a "Märklig"
else
  exec open -a "Märklig" "${args[@]}"
fi
"#;

#[tauri::command]
pub fn install_cli_tool() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use std::env;
        use std::fs;
        use std::process::Command;

        // Stage the script in a temp file so the privileged shell step is just
        // a mv/chmod — keeping the elevated command short reduces escaping risk.
        let staged = env::temp_dir().join("marklig-md-install.sh");
        fs::write(&staged, CLI_SCRIPT).map_err(|e| format!("write staged script: {e}"))?;

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
