//! Integration test for the embedded Typst compile path. We bypass the
//! Tauri command layer (which needs a running app context) and drive the
//! `TypstSession` + `typst::compile` pipeline directly — the command layer
//! is a thin wrapper, so this exercises the same logic.

#![cfg(not(any(target_os = "android", target_os = "ios")))]

use std::fs;

use tempfile::TempDir;
use typst::layout::PagedDocument;

use marklig_lib::typst::packages;
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

/// `@preview/...` import resolves against the on-disk cache. We pre-populate
/// a fixture package so the test never touches the network.
///
/// Cache layout matches typst-kit's `PackageStorage::prepare_package`:
///   `$cache/<namespace>/<name>/<version>/typst.toml`
///   `$cache/<namespace>/<name>/<version>/<entrypoint>`
#[test]
fn resolves_preview_package_from_cache() {
    let dir = TempDir::new().expect("tempdir");
    let cache = dir.path().join("typst-pkg-cache");
    let pkg_dir = cache.join("preview").join("dummy").join("0.1.0");
    fs::create_dir_all(&pkg_dir).expect("mkdir -p");
    // Minimal package manifest. typst-eval enforces a name + version + entrypoint.
    fs::write(
        pkg_dir.join("typst.toml"),
        r#"[package]
name = "dummy"
version = "0.1.0"
entrypoint = "lib.typ"
"#,
    )
    .expect("write manifest");
    // Entrypoint exposes one symbol the doc below imports.
    fs::write(
        pkg_dir.join("lib.typ"),
        "#let greet(who) = [Hello, #who!]\n",
    )
    .expect("write entrypoint");

    // Install the cache directory as the process-wide package storage.
    // (OK to call from a test — `init` overwrites any previous storage.)
    packages::init(cache.clone());

    // Doc that pulls a symbol out of the fixture package.
    let doc_path = dir.path().join("uses-pkg.typ");
    fs::write(
        &doc_path,
        r#"#import "@preview/dummy:0.1.0": greet

#greet("world")
"#,
    )
    .expect("write doc");

    let session = TypstSession::open(&doc_path).expect("open session");
    session.set_source(fs::read_to_string(&doc_path).expect("read"));
    let warned = typst::compile::<PagedDocument>(&session.world);
    let doc = warned
        .output
        .expect("compile should succeed against cached package");
    assert!(!doc.pages.is_empty(), "expected at least one page");
}

/// Live-network smoke test for `@preview/...` resolution. `#[ignore]` by
/// default — the CI sandbox doesn't allow outbound HTTPS. Run locally with:
///   `cargo test --test typst_basic -- --ignored resolves_preview_package_from_network`
#[test]
#[ignore]
fn resolves_preview_package_from_network() {
    // Use a real, tiny package. cetz is widely cached on packages.typst.org.
    let dir = TempDir::new().expect("tempdir");
    let cache = dir.path().join("typst-pkg-cache");
    packages::init(cache);

    let doc_path = dir.path().join("uses-cetz.typ");
    fs::write(
        &doc_path,
        r#"#import "@preview/cetz:0.2.2"

#cetz.canvas({})
"#,
    )
    .expect("write doc");

    let session = TypstSession::open(&doc_path).expect("open session");
    session.set_source(fs::read_to_string(&doc_path).expect("read"));
    let warned = typst::compile::<PagedDocument>(&session.world);
    assert!(
        warned.output.is_ok(),
        "live preview-package compile failed: {:?}",
        warned
            .output
            .err()
            .map(|errs| errs.iter().map(|e| e.message.to_string()).collect::<Vec<_>>())
    );
}
