//! Integration test for the embedded Typst compile path. We bypass the
//! Tauri command layer (which needs a running app context) and drive the
//! `TypstSession` + `typst::compile` pipeline directly — the command layer
//! is a thin wrapper, so this exercises the same logic.

#![cfg(not(any(target_os = "android", target_os = "ios")))]

use std::fs;

use tempfile::TempDir;
use typst::layout::PagedDocument;

use marklig_lib::typst::session::TypstSession;

#[test]
fn compiles_a_minimal_document() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("doc.typ");
    fs::write(&path, "= Hello world\n\nA paragraph.\n").expect("write");

    let session = TypstSession::open(&path).expect("open session");
    session.set_source(fs::read_to_string(&path).expect("read"));

    let warned = typst::compile::<PagedDocument>(&session.world);
    let doc = warned.output.expect("compile ok");
    assert!(!doc.pages.is_empty(), "expected at least one page");

    let svg = typst_svg::svg(&doc.pages[0]);
    assert!(svg.starts_with("<svg"), "got: {}", &svg[..svg.len().min(80)]);
    assert!(!svg.is_empty(), "svg should not be empty");
}

#[test]
fn reports_syntax_error_without_panic() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("broken.typ");
    // Unterminated string literal — a guaranteed parse-time failure.
    fs::write(&path, "#let x = \"unterminated\n").expect("write");

    let session = TypstSession::open(&path).expect("open session");
    session.set_source(fs::read_to_string(&path).expect("read"));

    let warned = typst::compile::<PagedDocument>(&session.world);
    // We deliberately do NOT assert is_err — typst may also surface this as
    // a warning + degenerate document. What we DO assert: the call returns
    // without panicking, and at least one diagnostic is produced.
    let has_diags = match &warned.output {
        Ok(_) => !warned.warnings.is_empty(),
        Err(errs) => !errs.is_empty(),
    };
    assert!(
        has_diags,
        "expected at least one diagnostic for broken source",
    );
}
