//! `World` implementation backing the in-process Typst compiler.
//!
//! Carries:
//! - the standard library + font book + system fonts (built once at session
//!   open)
//! - the entry file id (the `.typ` the user opened)
//! - a mutable in-memory copy of the entry source (updated each compile)
//!
//! Sibling files / assets are resolved relative to the entry file's parent
//! directory. Packages (`@preview/...`) are NOT resolved in Phase C — that
//! lands in Phase F via `crate::typst::packages`.

use std::path::{Path, PathBuf};

use chrono::Datelike;
use parking_lot::RwLock;

use ::typst::diag::{FileError, FileResult};
use ::typst::foundations::{Bytes, Datetime};
use ::typst::syntax::{FileId, Source, VirtualPath};
use ::typst::text::{Font, FontBook};
use ::typst::utils::LazyHash;
use ::typst::{Library, LibraryExt, World};
use ::typst_kit::fonts::{FontSearcher, FontSlot, Fonts};

pub struct ViewerWorld {
    library: LazyHash<Library>,
    fontbook: LazyHash<FontBook>,
    fonts: Vec<FontSlot>,
    root: PathBuf,
    main: FileId,
    main_source: RwLock<Source>,
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

        let Fonts { book, fonts } = FontSearcher::new()
            .include_system_fonts(true)
            .search();

        Ok(Self {
            library: LazyHash::new(Library::default()),
            fontbook: LazyHash::new(book),
            fonts,
            root,
            main,
            main_source: RwLock::new(main_source),
        })
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
        &self.fontbook
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main {
            return Ok(self.main_source.read().clone());
        }
        // Packages are unsupported in Phase C.
        if id.package().is_some() {
            return Err(FileError::Package(::typst::diag::PackageError::Other(
                Some("package resolution not yet implemented".into()),
            )));
        }
        let path = resolve_id(&self.root, id)?;
        let text =
            std::fs::read_to_string(&path).map_err(|err| FileError::from_io(err, &path))?;
        Ok(Source::new(id, text))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if id.package().is_some() {
            return Err(FileError::Package(::typst::diag::PackageError::Other(
                Some("package resolution not yet implemented".into()),
            )));
        }
        let path = resolve_id(&self.root, id)?;
        let bytes =
            std::fs::read(&path).map_err(|err| FileError::from_io(err, &path))?;
        Ok(Bytes::new(bytes))
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).and_then(|slot| slot.get())
    }

    fn today(&self, _offset: Option<i64>) -> Option<Datetime> {
        let now = chrono::Local::now();
        Datetime::from_ymd(now.year(), now.month() as u8, now.day() as u8)
    }
}

fn resolve_id(root: &Path, id: FileId) -> FileResult<PathBuf> {
    id.vpath().resolve(root).ok_or_else(|| {
        FileError::AccessDenied
    })
}
