//! Typst package resolution.
//!
//! Phase C ships a stub — `ViewerWorld::source` / `file` already reject
//! package-scoped file ids, so any `#import "@preview/..."` surfaces as a
//! compile error to the user. Full implementation (download + cache via
//! `typst-kit::package::PackageStorage`) lands in Phase F.
