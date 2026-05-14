// Runtime workaround for tao 0.35.2's panic on cold-launch with a file
// argument (issue #53 here; upstream tracked at tauri-apps/tao#1208).
//
// Symptom: launching the bundle via `open -a Märklig.app <path>` aborts with
//
//     core::panicking::panic_cannot_unwind
//     tao::platform_impl::platform::app_delegate::application_open_urls
//     -[NSApplication(NSAppleEventHandling) _handleAEOpenDocumentsForURLs:]
//
// Root cause: tao's `application:openURLs:` delegate method unwraps
// `NSURL.absoluteString()`. On macOS 26 (Tahoe) that returns nil for the
// URL AppKit hands over during cold-launch AppleEvent dispatch. Because the
// method is declared `extern "C"` (not `extern "C-unwind"`), the panic hits
// `panic_cannot_unwind` and aborts the process before any of our code runs.
//
// Workaround: swizzle the IMP of `application:openURLs:` on tao's app
// delegate class (`TaoAppDelegateParent`). Our replacement filters out URLs
// whose `absoluteString` is nil, then forwards the surviving array to tao's
// original IMP. tao then sees only URLs it can handle safely.
//
// This file can be removed once we ship a tao release that fixes #1208.

#![cfg(target_os = "macos")]

use std::ffi::CStr;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;
use objc2_foundation::{NSArray, NSURL};

/// Original `application:openURLs:` IMP from tao. Saved so our replacement
/// can forward the (filtered) call to it.
static ORIGINAL_OPEN_URLS_IMP: OnceLock<Imp> = OnceLock::new();

/// ObjC method signature for `-[id application:(NSApplication *) openURLs:(NSArray<NSURL *> *)]`.
type OpenUrlsFn = unsafe extern "C" fn(
    this: *mut AnyObject,
    cmd: Sel,
    app: *mut AnyObject,
    urls: *const NSArray<NSURL>,
);

/// Install the swizzle. Safe to call multiple times; only the first call has
/// any effect. Returns silently if tao's class isn't present (e.g. some
/// future tao version renames it) — degraded behavior is "no crash fix",
/// which is no worse than not running at all.
pub fn install() {
    if ORIGINAL_OPEN_URLS_IMP.get().is_some() {
        return;
    }

    // tao's app delegate is a class named "TaoAppDelegateParent", registered
    // lazily when tao first instantiates the event loop. Tauri builds the
    // event loop inside `Builder::build()`, so by the time we're called this
    // class exists. If a future tao renames it, we just no-op.
    let class_name = CStr::from_bytes_with_nul(b"TaoAppDelegateParent\0").unwrap();
    let Some(cls) = AnyClass::get(class_name) else {
        return;
    };
    let Some(method) = cls.instance_method(sel!(application:openURLs:)) else {
        return;
    };

    // SAFETY: our replacement has the exact same ObjC signature as tao's
    // original, and is strictly safer (it pre-filters nil-absoluteString
    // URLs that the original would have unwrapped). We store the previous
    // IMP and call it from the replacement, so tao's downstream behavior
    // (queuing the URLs through AppState::open_urls → RunEvent::Opened) is
    // preserved for the URLs we forward.
    let new_imp: OpenUrlsFn = safe_open_urls;
    let new_imp_raw: Imp = unsafe { std::mem::transmute::<OpenUrlsFn, Imp>(new_imp) };
    let previous = unsafe { method.set_implementation(new_imp_raw) };
    let _ = ORIGINAL_OPEN_URLS_IMP.set(previous);
}

/// Replacement IMP for `-[TaoAppDelegateParent application:openURLs:]`.
///
/// Filters out URLs whose `absoluteString` is nil (the source of tao's
/// panic), retains the rest, packs them into a fresh `NSArray<NSURL>`, and
/// invokes tao's original IMP with that filtered array.
unsafe extern "C" fn safe_open_urls(
    this: *mut AnyObject,
    cmd: Sel,
    app: *mut AnyObject,
    urls: *const NSArray<NSURL>,
) {
    // SAFETY: AppKit always passes a non-null NSArray to this selector.
    let urls_ref: &NSArray<NSURL> = unsafe { &*urls };
    let count = urls_ref.count();

    let mut safe: Vec<Retained<NSURL>> = Vec::with_capacity(count);
    for i in 0..count {
        // objectAtIndex is bounds-checked by `count`; the returned NSURL is
        // already retained for us by objc2.
        let url = urls_ref.objectAtIndex(i);
        // The actual fix: only keep URLs whose absoluteString is non-nil.
        // (The original tao code does `.absoluteString().unwrap()`; that's
        // the panic site.)
        if url.absoluteString().is_some() {
            safe.push(url);
        }
    }

    if safe.is_empty() {
        // Nothing tao can safely consume. Returning is fine — application
        // launch continues, just without any opened documents. The user
        // can still File→Open or drag-drop in.
        return;
    }

    let filtered: Retained<NSArray<NSURL>> = NSArray::from_retained_slice(&safe);

    let Some(original) = ORIGINAL_OPEN_URLS_IMP.get() else {
        // install() didn't run, or tao's method was missing. Bail rather
        // than re-enter our own IMP.
        return;
    };
    // SAFETY: `original` was obtained from `method.set_implementation`,
    // which returns the previous IMP for the same selector and class. The
    // signature therefore matches OpenUrlsFn exactly.
    let original_fn: OpenUrlsFn = unsafe { std::mem::transmute::<Imp, OpenUrlsFn>(*original) };
    unsafe {
        original_fn(this, cmd, app, &*filtered as *const NSArray<NSURL>);
    }
}
