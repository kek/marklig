//! `World` implementation backing the in-process Typst compiler.
//!
//! Carries:
//! - the standard library (built once at session open)
//! - the entry file id (the `.typ` the user opened)
//! - a mutable in-memory copy of the entry source (updated each compile)
//!
//! The font book + system font slots are shared across every `ViewerWorld`
//! via a process-wide `OnceLock` — scanning system fonts on every session
//! open added hundreds of milliseconds per `.typ` file opened on macOS.
//!
//! Sibling files / assets are resolved relative to the entry file's parent
//! directory. Packages (`@preview/...`) are NOT resolved in Phase C — that
//! lands in Phase F via `crate::typst::packages`.
//!
//! The world also records which local files a compile actually *read*, so the
//! preview can be recompiled when an import three levels down changes — see
//! `begin_dependency_capture` / `finish_dependency_capture`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::Datelike;
use parking_lot::RwLock;

use ::typst::diag::{FileError, FileResult};
use ::typst::foundations::{Bytes, Datetime};
use ::typst::syntax::{FileId, Source, VirtualPath};
use ::typst::text::{Font, FontBook};
use ::typst::utils::LazyHash;
use ::typst::{Library, LibraryExt, World};
use ::typst_kit::fonts::{FontSearcher, FontSlot, Fonts};

use crate::typst::packages;

/// System font book + slots, scanned once per process and shared across every
/// `ViewerWorld`. The original implementation rescanned on every session open,
/// which adds hundreds of milliseconds per `.typ` file opened on macOS.
struct SharedFonts {
    book: LazyHash<FontBook>,
    slots: Vec<FontSlot>,
}

static SHARED_FONTS: OnceLock<SharedFonts> = OnceLock::new();

fn shared_fonts() -> &'static SharedFonts {
    SHARED_FONTS.get_or_init(|| {
        let Fonts { book, fonts } = FontSearcher::new()
            .include_system_fonts(true)
            .search();
        SharedFonts {
            book: LazyHash::new(book),
            slots: fonts,
        }
    })
}

pub struct ViewerWorld {
    library: LazyHash<Library>,
    root: PathBuf,
    main: FileId,
    main_source: RwLock<Source>,
    /// Absolute path of the entry file. Always a dependency of every compile,
    /// but `source()` short-circuits the main id before it reaches
    /// `resolve_path`, so it is recorded from here instead.
    entry: PathBuf,
    /// Local files resolved during the compile currently in flight. Reset by
    /// `begin_dependency_capture`.
    pending_deps: RwLock<BTreeSet<PathBuf>>,
    /// The set to watch. Replaced wholesale by a successful compile; a failed
    /// one is only allowed to *add* to it. A compile that dies on a parse
    /// error in the entry file never reaches the imports, so its `pending` set
    /// is a near-empty subset of the truth — adopting that would unwatch every
    /// import, and the fix the user then makes in one of them would not
    /// retrigger. Keeping the last good set means the graph only shrinks when
    /// a compile actually proves it smaller.
    watched_deps: RwLock<BTreeSet<PathBuf>>,
}

impl ViewerWorld {
    pub fn new(entry_path: &Path) -> Result<Self, std::io::Error> {
        let root = entry_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let rel = entry_path
            .file_name()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("main.typ"));
        let main = FileId::new(None, VirtualPath::new(rel));
        let source_text = std::fs::read_to_string(entry_path)?;
        let main_source = Source::new(main, source_text);

        // Touch the lazy font init so the first compile doesn't pay for it
        // unexpectedly. Subsequent sessions reuse the cached `SharedFonts`.
        let _ = shared_fonts();

        Ok(Self {
            library: LazyHash::new(Library::default()),
            root,
            main,
            main_source: RwLock::new(main_source),
            entry: entry_path.to_path_buf(),
            pending_deps: RwLock::new(BTreeSet::new()),
            watched_deps: RwLock::new(BTreeSet::new()),
        })
    }

    /// Record a local file the compiler asked for. Package files are excluded
    /// by the caller: they live in the immutable shared package cache, so
    /// watching them would be pure cost.
    fn note_dependency(&self, path: &Path) {
        self.pending_deps.write().insert(path.to_path_buf());
    }

    /// Start recording dependencies for one compile. Call immediately before
    /// `typst::compile`, under the session's compile lock.
    pub fn begin_dependency_capture(&self) {
        let mut pending = self.pending_deps.write();
        pending.clear();
        pending.insert(self.entry.clone());
    }

    /// Finish recording and return the paths worth watching.
    ///
    /// `succeeded` selects the merge rule described on `watched_deps`: a
    /// successful compile replaces the set, a failed one may only extend it.
    pub fn finish_dependency_capture(&self, succeeded: bool) -> Vec<PathBuf> {
        let pending = self.pending_deps.read();
        let mut watched = self.watched_deps.write();
        if succeeded {
            *watched = pending.clone();
        } else {
            watched.extend(pending.iter().cloned());
        }
        watched.iter().cloned().collect()
    }

    /// Replace the in-memory main source for the next compile.
    pub fn set_main_source(&self, text: String) {
        let mut guard = self.main_source.write();
        *guard = Source::new(self.main, text);
    }

    /// Clone the current main source. Cheap (`Source` is reference-counted).
    pub fn main_source_ref(&self) -> Source {
        self.main_source.read().clone()
    }

    #[allow(dead_code)]
    pub fn main_id(&self) -> FileId {
        self.main
    }
}

impl World for ViewerWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &shared_fonts().book
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main {
            return Ok(self.main_source.read().clone());
        }
        let path = resolve_path(&self.root, id)?;
        // Recorded before the read, deliberately: an import the document names
        // but that does not exist yet is exactly the file whose *creation*
        // should retrigger a compile.
        if id.package().is_none() {
            self.note_dependency(&path);
        }
        let text =
            std::fs::read_to_string(&path).map_err(|err| FileError::from_io(err, &path))?;
        Ok(Source::new(id, text))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        let path = resolve_path(&self.root, id)?;
        if id.package().is_none() {
            self.note_dependency(&path);
        }
        let bytes =
            std::fs::read(&path).map_err(|err| FileError::from_io(err, &path))?;
        Ok(Bytes::new(bytes))
    }

    fn font(&self, index: usize) -> Option<Font> {
        shared_fonts().slots.get(index).and_then(|slot| slot.get())
    }

    fn today(&self, _offset: Option<i64>) -> Option<Datetime> {
        let now = chrono::Local::now();
        Datetime::from_ymd(now.year(), now.month() as u8, now.day() as u8)
    }
}

/// Resolve a `FileId` to a real on-disk path.
///
/// - Local file ids (no package) are resolved relative to the entry file's
///   parent directory.
/// - Package-scoped ids (e.g. `@preview/cetz:0.2.2`) are resolved through
///   `crate::typst::packages::prepare_package`, which downloads + caches the
///   package on first use and returns the cached root. The virtual path is
///   then resolved relative to that root.
fn resolve_path(root: &Path, id: FileId) -> FileResult<PathBuf> {
    if let Some(spec) = id.package() {
        let pkg_root = packages::prepare_package(spec).map_err(FileError::Package)?;
        return id
            .vpath()
            .resolve(&pkg_root)
            .ok_or(FileError::AccessDenied);
    }
    id.vpath().resolve(root).ok_or(FileError::AccessDenied)
}
