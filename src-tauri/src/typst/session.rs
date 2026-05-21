//! Per-document Typst compile session.
//!
//! Intentionally thin: `comemo` does the heavy memoization across calls to
//! `typst::compile(&session.world)`. Keeping the same `ViewerWorld` instance
//! across compiles is what lets the comemo cache reuse fonts, library hashes,
//! and parsed sibling source files.

use std::path::Path;

use crate::typst::world::ViewerWorld;

pub struct TypstSession {
    pub world: ViewerWorld,
}

impl TypstSession {
    pub fn open(path: &Path) -> Result<Self, std::io::Error> {
        Ok(Self {
            world: ViewerWorld::new(path)?,
        })
    }

    pub fn set_source(&self, text: String) {
        self.world.set_main_source(text);
    }
}
