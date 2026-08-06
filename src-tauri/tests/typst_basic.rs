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
    let (ok, deps) =
        compile_capturing_deps(&session, &fs::read_to_string(&doc_path).expect("read"));
    assert!(ok, "compile should succeed against cached package");

    // Package files live in the immutable shared cache, so watching them would
    // be cost with no possible payoff — they must stay out of the set, while
    // the local entry file stays in it.
    //
    // Asserted here rather than in a test of its own on purpose: `packages::init`
    // installs *process-wide* storage, and cargo runs these tests as threads in
    // one process. A second test that called `init` with its own fixture would
    // race this one and resolve against whichever cache won.
    assert!(
        !deps.iter().any(|d| d.starts_with(&cache)),
        "package cache file leaked into the watch set: {deps:?}",
    );
    assert!(
        deps.iter().any(|d| d.ends_with("uses-pkg.typ")),
        "entry file missing from {deps:?}",
    );
}

/// Build a three-level import chain in `dir`:
///   main.typ -> sub/level1.typ -> sub/level2.typ
/// `main.typ` never names `level2.typ`, so a dependency set that only reads
/// the entry file's own import statements cannot find it.
fn write_import_chain(dir: &std::path::Path, leaf: &str) -> std::path::PathBuf {
    let main = dir.join("main.typ");
    fs::create_dir_all(dir.join("sub")).expect("mkdir sub");
    fs::write(&main, "#import \"sub/level1.typ\": one\n\nA: #one\n").expect("write main");
    fs::write(
        dir.join("sub").join("level1.typ"),
        "#import \"level2.typ\": two\n#let one = [L1 sees #two]\n",
    )
    .expect("write level1");
    fs::write(
        dir.join("sub").join("level2.typ"),
        format!("#let two = [{leaf}]\n"),
    )
    .expect("write level2");
    main
}

fn compile_capturing_deps(session: &TypstSession, source: &str) -> (bool, Vec<std::path::PathBuf>) {
    session.set_source(source.to_string());
    session.world.begin_dependency_capture();
    let warned = typst::compile::<PagedDocument>(&session.world);
    let ok = warned.output.is_ok();
    (ok, session.world.finish_dependency_capture(ok))
}

/// The dependency set must reach files the entry document never names —
/// otherwise the preview cannot know to recompile when `level2.typ` changes.
#[test]
fn dependency_capture_reaches_transitive_imports() {
    let dir = TempDir::new().expect("tempdir");
    let main = write_import_chain(dir.path(), "ORIGINAL");

    let session = TypstSession::open(&main).expect("open session");
    let (ok, deps) = compile_capturing_deps(&session, &fs::read_to_string(&main).expect("read"));
    assert!(ok, "fixture should compile");

    let ends_with = |name: &str| deps.iter().any(|d| d.ends_with(name));
    assert!(ends_with("main.typ"), "entry file missing from {deps:?}");
    assert!(ends_with("sub/level1.typ"), "direct import missing from {deps:?}");
    assert!(
        ends_with("sub/level2.typ"),
        "transitive import missing from {deps:?}",
    );
}

/// The compiler half of auto-reload: with the *same* session and an untouched
/// main source, a change to a file two levels down must reach the next render.
/// `ViewerWorld` caches no file slots, so comemo revalidates by re-reading —
/// there is no `reset()` to call, and this test is what says so.
#[test]
fn recompiles_against_changed_transitive_import() {
    let dir = TempDir::new().expect("tempdir");
    let main = write_import_chain(dir.path(), "ORIGINAL");
    let source = fs::read_to_string(&main).expect("read");

    let session = TypstSession::open(&main).expect("open session");
    let first = typst::compile::<PagedDocument>(&session.world);
    let before = typst_svg::svg(&first.output.expect("first compile").pages[0]);

    // Change only the leaf. The entry buffer is not touched.
    fs::write(
        dir.path().join("sub").join("level2.typ"),
        "#let two = [CHANGEDLEAF]\n",
    )
    .expect("rewrite leaf");

    session.set_source(source);
    let second = typst::compile::<PagedDocument>(&session.world);
    let after = typst_svg::svg(&second.output.expect("second compile").pages[0]);

    assert_ne!(
        before, after,
        "a changed transitive import did not reach the re-render",
    );
}

/// A compile that dies before it reaches the imports must not shrink the watch
/// set. If it did, the user's fix — typically made in one of those very
/// imports — would land on an unwatched file and never retrigger.
#[test]
fn failed_compile_does_not_shrink_the_dependency_set() {
    let dir = TempDir::new().expect("tempdir");
    let main = write_import_chain(dir.path(), "ORIGINAL");

    let session = TypstSession::open(&main).expect("open session");
    let (ok, good) = compile_capturing_deps(&session, &fs::read_to_string(&main).expect("read"));
    assert!(ok, "fixture should compile");
    assert!(good.iter().any(|d| d.ends_with("sub/level2.typ")));

    // Unterminated string: fails at parse time, before any import is resolved.
    let (ok, after_failure) = compile_capturing_deps(&session, "#let x = \"unterminated\n");
    assert!(!ok, "broken source should not compile");
    assert!(
        after_failure.iter().any(|d| d.ends_with("sub/level2.typ")),
        "failed compile dropped the transitive import: {after_failure:?}",
    );

    // ...and a later good compile is still allowed to shrink it back down.
    fs::write(&main, "= No imports here\n").expect("rewrite main");
    let (ok, narrowed) = compile_capturing_deps(&session, "= No imports here\n");
    assert!(ok, "import-free document should compile");
    assert!(
        !narrowed.iter().any(|d| d.ends_with("sub/level2.typ")),
        "successful compile should have replaced the set: {narrowed:?}",
    );
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
