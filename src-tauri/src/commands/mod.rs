// All current command modules are desktop-only — they depend on the
// `notify` filesystem watcher (no Android equivalent), macOS-only AppKit
// integration, or path-based filesystem APIs that don't translate to
// Android's Storage Access Framework. Step 2 of the mobile companion plan
// introduces a parallel mobile file shell; until then, mobile builds expose
// no commands beyond `take_pending_open_paths` (in `lib.rs`).
#[cfg(desktop)]
pub mod cli_tool;
#[cfg(desktop)]
pub mod files;
#[cfg(desktop)]
pub mod folder_watcher;
#[cfg(desktop)]
pub mod recents_os;
#[cfg(desktop)]
pub mod watcher;
