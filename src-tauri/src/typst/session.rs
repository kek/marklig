//! Per-document Typst compile session.
//!
//! Intentionally thin: `comemo` does the heavy memoization across calls to
//! `typst::compile(&session.world)`. Keeping the same `ViewerWorld` instance
//! across compiles is what lets the comemo cache reuse fonts, library hashes,
//! and parsed sibling source files.

use std::path::Path;

use parking_lot::Mutex;

use crate::typst::world::ViewerWorld;

pub struct TypstSession {
    pub world: ViewerWorld,
    /// Held for the duration of a single compile (set_source + typst::compile).
    /// Without this, two concurrent `typst_compile` calls for the same session
    /// can race: the in-flight compile reads `main_source` through
    /// `World::source` more than once, and a newer `set_source` from the
    /// second call mutates it mid-flight, producing pages and diagnostics
    /// derived from a mix of source revisions.
    pub compile_lock: Mutex<()>,
}

impl TypstSession {
    pub fn open(path: &Path) -> Result<Self, std::io::Error> {
        Ok(Self {
            world: ViewerWorld::new(path)?,
            compile_lock: Mutex::new(()),
        })
    }

    pub fn set_source(&self, text: String) {
        self.world.set_main_source(text);
    }
}
