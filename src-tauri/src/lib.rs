mod commands;
#[cfg(target_os = "macos")]
mod mac_tao_patch;
// `mdns` is public so the discovery integration test can drive the
// announcer and the resolver directly, the way `typst` is exposed for
// `typst_basic.rs`. Not gated to desktop: the announcer half is desktop-only
// in practice, but `resolve_instance`/`browse_peers` are what the phone uses
// to find a desktop whose address has moved, so the module has to exist in a
// mobile build.
pub mod mdns;
pub mod mobile_pairing_record;
#[cfg(desktop)]
mod pairing;
#[cfg(desktop)]
mod pairing_ws;
#[cfg(desktop)]
mod session;
#[cfg(desktop)]
mod sync_log;
#[cfg(desktop)]
mod sync_watcher;
#[cfg(desktop)]
mod sync_session;
#[cfg(desktop)]
pub mod typst;

#[cfg(desktop)]
use commands::folder_watcher::FolderWatcherState;
#[cfg(desktop)]
use commands::watcher::WatcherState;
use tauri::RunEvent;
// Desktop pulls `Manager` in for the setup closure (`try_state`, `path`) and
// the quit-flush (`webview_windows`); apple/android pull it in for the
// RunEvent::Opened window handling.
#[cfg(any(desktop, target_os = "ios", target_os = "android"))]
use tauri::Manager;
#[cfg(desktop)]
use tauri::{Emitter, Listener};
// Windows/Linux desktop need Emitter for the quit-flush broadcast even
// though they don't import Manager (no RunEvent::Opened buffer to drain).
// macOS gets Emitter via the cfg(desktop) line above.
#[cfg(any(target_os = "ios", target_os = "android"))]
use tauri::Emitter;

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use std::sync::Mutex;

// Atomic guard: once we've broadcast `viewer:before-quit` and re-entered
// `RunEvent::ExitRequested`, skip the broadcast/wait dance the second time
// so `app.exit()` from the wait task actually terminates the process. Set
// from inside the wait task immediately before re-issuing the exit.
#[cfg(desktop)]
static QUIT_FLUSH_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

// macOS cold-launch with a path argument fires `RunEvent::Opened` *before*
// Tauri runs its `setup` (which is what creates the configured main window).
// If we spawn-or-emit at that moment, either we beat setup to creating "main"
// (panic: webview already exists) or we have no window to emit to. Buffer the
// paths instead, and replay them once `RunEvent::Ready` fires.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
static PENDING_OPEN_PATHS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Drain paths that the OS handed to us via `RunEvent::Opened` during launch,
/// before the frontend was ready to receive events. Mobile-only: desktop's
/// `RunEvent::Ready` handler now drains `PENDING_OPEN_PATHS` itself and hands
/// it straight to `session::run_launch`, so the frontend never needs to ask.
/// Mobile has no window-management Rust side yet, so its bootstrap still
/// calls this directly.
#[cfg(mobile)]
#[tauri::command]
fn take_pending_open_paths() -> Vec<String> {
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
    {
        PENDING_OPEN_PATHS
            .lock()
            .map(|mut v| std::mem::take(&mut *v))
            .unwrap_or_default()
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        Vec::new()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build());

    // Desktop-only: file-shell state and commands. Mobile (Android, iOS)
    // builds skip these entirely — the mobile shell lands in a later step
    // of the v2 companion plan.
    #[cfg(desktop)]
    let builder = builder
        .manage(WatcherState::new())
        .manage(FolderWatcherState::new())
        .manage(pairing::PairingState::new())
        .manage(std::sync::Arc::new(pairing_ws::WsServerState::new()))
        .manage(self::typst::TypstState::new())
        .manage(std::sync::Arc::new(sync_watcher::SyncWatcherState::new()))
        .manage(std::sync::Arc::new(sync_session::SyncSessionRegistry::new()))
        .setup(|app| {
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
                let config_dir =
                    app.path().app_config_dir().unwrap_or_else(|_| app_data.clone());
                if let Some(migrated) =
                    session::store::migrate_from_plugin_store(&app_data, &config_dir)
                {
                    if let Err(err) = session::store::write_session(&app_data, &migrated) {
                        eprintln!("session migration write failed: {err}");
                    }
                }
            }
            app.manage(session::SessionState::new(app_data));

            // Spin up the pairing-WS server. Runs for the app's lifetime;
            // only accepts *handshakes* when armed via pairing_start, but
            // serves sync to already-paired phones throughout — and
            // announces `_marklig-sync._tcp` for as long as it is bound, so
            // a phone can find this desktop again after a DHCP change
            // without anyone opening the pairing modal.
            pairing_ws::spawn_server(app.handle().clone());
            // Reconcile sync logs: catch drift from while the app was closed.
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let pairings = crate::pairing::list_all_pairings(&app_handle)
                        .unwrap_or_default();
                    for meta in pairings {
                        for folder in &meta.synced_folders {
                            if let Err(e) = crate::sync_log::reconcile_folder(
                                &app_handle,
                                &meta.pair_id_hex,
                                folder,
                            ) {
                                eprintln!("sync reconcile {folder}: {e}");
                            }
                        }
                    }
                });
            }
            // Start file watchers for all already-synced folders so that
            // changes made while the app was open are picked up immediately.
            {
                let app_handle_w = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let pairings = crate::pairing::list_all_pairings(&app_handle_w)
                        .unwrap_or_default();
                    if let Some(watcher_state) = app_handle_w
                        .try_state::<std::sync::Arc<crate::sync_watcher::SyncWatcherState>>()
                    {
                        for meta in pairings {
                            for folder in &meta.synced_folders {
                                let _ = watcher_state.register(
                                    &app_handle_w,
                                    &meta.pair_id_hex,
                                    folder,
                                );
                            }
                        }
                    }
                });
            }
            // Wire the Typst package cache to the app's data dir so that
            // downloaded `@preview/...` packages persist across launches.
            // If the data dir is unavailable for some reason, the package
            // resolver falls back to typst-kit's XDG default.
            if let Ok(data_dir) = app.path().app_data_dir() {
                self::typst::packages::init(data_dir.join("typst/packages"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::files::read_text_file,
            commands::files::read_image_base64,
            commands::files::write_text_file,
            commands::files::rename_file,
            commands::files::trash_file,
            commands::watcher::watcher_start,
            commands::watcher::watcher_stop,
            commands::watcher::watcher_mark_self_write,
            commands::files::write_recovery,
            commands::files::read_all_recovery,
            commands::files::clear_recovery,
            commands::files::list_documents,
            commands::files::is_directory,
            commands::files::path_exists,
            commands::files::resolve_folder_root,
            commands::files::canonicalize_path,
            commands::files::reveal_in_file_manager,
            commands::recents_os::register_recent_document,
            commands::export_pdf::export_pdf,
            commands::folder_watcher::folder_watcher_start,
            commands::folder_watcher::folder_watcher_stop,
            commands::cli_tool::install_cli_tool,
            pairing::pairing_start,
            pairing::pairing_cancel,
            pairing::pairing_list,
            pairing::pairing_unpair,
            pairing::folder_sync_enable,
            pairing::folder_sync_disable,
            self::mdns::mdns_browse_peers,
            self::mdns::mdns_resolve_instance,
            self::typst::typst_open,
            self::typst::typst_compile,
            self::typst::typst_close,
            commands::mobile_sync::sync_compact,
            session::session_report,
            session::session_forget,
            session::session_open_paths,
            session::session_new_window,
        ]);

    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        take_pending_open_paths,
        commands::mobile_pairing::mobile_pairing_start,
        commands::mobile_sync::mobile_sync_now,
        commands::mobile_sync::mobile_read_synced_file,
        commands::mobile_sync::mobile_unpair,
        commands::mobile_sync::mobile_apply_sync_op,
        // The phone's half of the DHCP fix: `resolve` is what the sync client
        // calls when the desktop's stored address stops answering. `browse` has
        // no caller on the phone yet — pairing takes its host from the QR — but
        // the two are one API, and a mobile build that has only half of it
        // would be a trap for the next person to reach for the other half.
        self::mdns::mdns_browse_peers,
        self::mdns::mdns_resolve_instance,
    ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // macOS only: tao 0.35.2 panics in `application:openURLs:` when AppKit
    // hands it a URL whose `absoluteString` is nil (issue #53 here, upstream
    // tauri-apps/tao#1208). On macOS 26 this is hit on cold launch from
    // `open -a Märklig.app <path>` and from Finder file-association launches.
    // Install our nil-filtering swizzle now, after tauri's build() has set
    // up tao's delegate class but before `.run()` enters the event loop.
    #[cfg(target_os = "macos")]
    mac_tao_patch::install();

    app.run(|app, event| match event {
        // macOS only: closing the last window normally terminates the app.
        // Standard Mac behavior is for the app to stay alive until the
        // user picks Quit (Cmd-Q). `code.is_none()` is Tauri's way of
        // distinguishing "user closed the last window" from an explicit
        // `app.exit(code)` (which Cmd-Q / the Quit menu route through).
        #[cfg(target_os = "macos")]
        RunEvent::ExitRequested { code, api, .. } if code.is_none() => {
            api.prevent_exit();
        }
        // App-quit with an explicit exit code — Cmd-Q on macOS, the Quit
        // menu, programmatic `app.exit()`. On macOS Tao tears windows down
        // without firing per-window `CloseRequested`, so the frontend
        // close-handler's force-save path never runs. Intercept here,
        // broadcast `viewer:before-quit`, wait for one ack per window
        // (best-effort with a timeout), then re-issue the exit.
        //
        // The QUIT_FLUSH_DONE guard prevents an infinite loop: after the
        // wait task calls `app.exit(0)` we re-enter this arm; the guard
        // makes the second visit fall through and let the runtime exit.
        #[cfg(desktop)]
        RunEvent::ExitRequested { code: Some(_), api, .. }
            if !QUIT_FLUSH_DONE.load(std::sync::atomic::Ordering::SeqCst) =>
        {
            api.prevent_exit();
            spawn_quit_flush(app.clone());
        }
        // macOS only: dock-icon click after we kept the app alive without
        // any windows. Route it through the same path as everything else so
        // the click behaves like any other spawn request.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } if !has_visible_windows => {
            session::apply_route(app, session::router::Route::Spawn { folder: None, file: None });
        }
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
        _ => {}
    });
}

/// Broadcast `viewer:before-quit` to every window, give each one up to
/// QUIT_FLUSH_TIMEOUT_MS to call its frontend force-save and ack via
/// `viewer:before-quit-ack`, then re-issue the app exit. Best-effort: we
/// exit on timeout even if some windows haven't acked, so a frozen window
/// can't strand the rest of the process.
///
/// Runs off the main thread via `std::thread::spawn` because polling for
/// acks must NOT block the Tauri event loop — the loop is what dispatches
/// the JS side's emit-back. (Tauri lets you call `app.exit()` from any
/// thread.)
#[cfg(desktop)]
fn spawn_quit_flush(app: tauri::AppHandle) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const QUIT_FLUSH_TIMEOUT_MS: u64 = 3000;

    let expected = app.webview_windows().len();
    if expected == 0 {
        // No windows to flush — exit straight away.
        QUIT_FLUSH_DONE.store(true, Ordering::SeqCst);
        app.exit(0);
        return;
    }

    let acks = Arc::new(AtomicUsize::new(0));
    let acks_clone = acks.clone();
    // Listener has to be installed BEFORE the broadcast so we don't miss
    // fast acks. `listen_any` returns an id we'd unlisten on completion,
    // but since the process is about to exit it's not worth tracking.
    let _id = app.listen_any("viewer:before-quit-ack", move |_event| {
        acks_clone.fetch_add(1, Ordering::SeqCst);
    });

    if let Err(err) = app.emit("viewer:before-quit", ()) {
        eprintln!("viewer:before-quit broadcast failed: {err:?}");
        QUIT_FLUSH_DONE.store(true, Ordering::SeqCst);
        app.exit(0);
        return;
    }

    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_millis(QUIT_FLUSH_TIMEOUT_MS);
        while Instant::now() < deadline {
            if acks.load(Ordering::SeqCst) >= expected {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        QUIT_FLUSH_DONE.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

