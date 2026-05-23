//! Typst package resolution (`@preview/...`).
//!
//! Wraps `typst-kit::package::PackageStorage` with two cache paths:
//!
//! - `cache_dir` — where packages we downloaded live (Tauri's app data dir
//!   joined with `"typst/packages"`).
//! - `package_path` — where pre-installed / vendored packages live; not used
//!   in the desktop build but the API requires it.
//!
//! The first time a `#import "@preview/cetz:0.2.2"` runs, `prepare_package`
//! checks the cache, downloads the tar.gz from
//! `https://packages.typst.org/preview/cetz-0.2.2.tar.gz` if missing,
//! extracts it under `$cache/preview/cetz/0.2.2/`, and returns the local
//! path. Subsequent runs hit the cache.

use std::path::PathBuf;
use std::sync::RwLock;

use ::typst::diag::PackageError;
use ::typst::syntax::package::PackageSpec;
use ::typst_kit::download::{Downloader, ProgressSink};
use ::typst_kit::package::PackageStorage;

/// Process-wide package storage. Stored behind an `RwLock<Option<…>>` so the
/// app's `setup` hook can install the real cache directory at startup, and
/// tests can substitute a pre-populated fixture directory. Without an
/// installed storage, `prepare_package` falls back to typst-kit's defaults
/// (XDG dirs) — fine for ad-hoc runs but not what we want in production.
static STORAGE: RwLock<Option<PackageStorage>> = RwLock::new(None);

/// Install the global package storage to use the given cache directory.
/// Safe to call repeatedly — the latest call wins. Typically called once
/// from the Tauri `setup` hook with `app_data_dir().join("typst/packages")`.
pub fn init(cache_dir: PathBuf) {
    let storage = build_storage(Some(cache_dir));
    *STORAGE.write().expect("packages storage poisoned") = Some(storage);
}

/// Build a `PackageStorage` with the configured cache dir. `package_path`
/// is left at the typst-kit default; desktop builds only use the cache.
fn build_storage(cache_dir: Option<PathBuf>) -> PackageStorage {
    // The downloader's user-agent string is sent to packages.typst.org so
    // the registry can identify clients in its logs.
    let downloader = Downloader::new("marklig/0.1");
    PackageStorage::new(cache_dir, None, downloader)
}

/// Resolve a namespaced package spec (`@preview/...`) to a local directory.
/// Downloads + caches transparently when the cache misses; subsequent calls
/// return the cached path.
pub fn prepare_package(spec: &PackageSpec) -> Result<PathBuf, PackageError> {
    let guard = STORAGE.read().expect("packages storage poisoned");
    match guard.as_ref() {
        Some(storage) => storage.prepare_package(spec, &mut ProgressSink),
        None => {
            // Storage not installed yet (e.g. running outside the Tauri
            // setup hook). Build a transient instance with typst-kit's
            // XDG defaults. We don't cache it because `init` may be
            // called later, and we want subsequent calls to honor it.
            let storage = build_storage(None);
            storage.prepare_package(spec, &mut ProgressSink)
        }
    }
}
