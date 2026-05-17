# Mobile companion — Step 2: SAF MobileFileShell + share-sheet

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Android share-sheet / file-open intent into the mobile bootstrap so the user can open any `.md` from Files, an email attachment, a messaging app, or "Share to Märklig" — and persist a SAF tree URI so step 3's library indexer can enumerate a folder. End-to-end: tap "Open with Märklig" on an `.md` somewhere on the phone, the app opens with that document rendered.

**Architecture:** Use `tauri-plugin-deep-link` (already in the Tauri 2 ecosystem) to receive the inbound URI from Android's intent system. Read the content via `@tauri-apps/plugin-fs.readTextFile` — Tauri 2's fs plugin on Android resolves `content://` URIs via SAF. Persist tree URIs (returned by the SAF folder picker) in the existing `tauri-plugin-store`.

The MobileFileShell interface mirrors the *capabilities* of the desktop file shell — read text, list a folder, persist tree-URI permissions — without trying to mirror the *paths*. SAF is URI-based; the JS surface returns URIs as opaque strings, and `displayName` / `mimeType` / `lastModified` from `DocumentFile`. No path arithmetic; treat URIs as IDs.

**Tech stack additions:** `tauri-plugin-deep-link` (Rust + JS package). No new platform Kotlin code beyond what tauri scaffolds for the plugin and a thin SAF folder-picker activity contract.

**Spec:** `docs/superpowers/specs/2026-05-17-mobile-companion-design.md` §6.4 (Android storage API), §5 (renderer reuse / shell-not-shared boundary).

**VCS note:** This repository is a Jujutsu (`.jj/`) repo. Commits use `jj`, not raw `git`. See `docs/superpowers/plans/2026-05-17-mobile-companion-1-tauri-android-init.md` for the pattern.

---

## Scope boundaries

In scope:
- Receive `Intent.ACTION_VIEW` / `Intent.ACTION_SEND` for Markdown files (cold start and warm) and render the content.
- A `MobileFileShell` JS interface and a single Android implementation (`SafMobileFileShell`) that talks to Tauri commands.
- SAF folder picker — user picks one directory, we hold a persisted tree URI.
- Enumerate `.md` files in a picked tree URI (the step-3 library will consume this).
- Persist the most recently opened content URI and the most recently picked tree URI in `tauri-plugin-store` — these are the "recents" + "library folder" carriers for step 3.

Out of scope:
- Writing files (mobile is read-only in v2.0).
- Library / recents UI (step 3).
- Multi-folder picking (step 3 may extend; step 2 supports one).
- Sync, pairing, crypto (steps 4–7).
- iOS (v2.1+).

---

## File structure

```
viewer/
├── src-tauri/
│   ├── Cargo.toml                              (mod) add tauri-plugin-deep-link
│   ├── tauri.conf.json                         (mod) deep-link plugin config (schemes/domains, mobile share targets) — only if needed beyond manifest
│   ├── capabilities/
│   │   └── mobile.json                         (NEW) mobile-only permissions: deep-link:default, fs:allow-read-text-file etc.
│   ├── gen/android/app/src/main/
│   │   └── java/se/karleklund/marklig/
│   │       └── MainActivity.kt                 (mod) forward launch intent to deep-link plugin; pick-folder activity result handler
│   └── src/
│       ├── lib.rs                              (mod) register deep-link plugin on mobile
│       └── commands/
│           └── mobile_fs.rs                    (NEW) cfg(mobile) — list_markdown_in_tree (calls into Kotlin via tauri::plugin or jni)
├── src/
│   ├── shell/
│   │   ├── mobile-fs.ts                        (NEW) MobileFileShell interface + Saf implementation
│   │   └── store.ts                            (used) persist last-opened URI + tree-URI
│   ├── mobile-bootstrap.ts                     (mod) on deep-link event, read content URI, replace editor doc
│   └── platform.ts                             (mod) probably no changes — keep isMobile() the same
├── tests/
│   └── shell/
│       └── mobile-fs.test.ts                   (NEW) unit tests for the JS shape (mocks the Tauri invokes)
└── ROADMAP.md                                  (mod) flip step 2 to in-progress / completed
```

---

## Task 1: Install `tauri-plugin-deep-link`

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `package.json`

- [ ] **Step 1: Rust crate**

In `src-tauri/Cargo.toml`, add to the unconditional `[dependencies]` block (the plugin compiles for desktop too — it's a no-op there):

```toml
tauri-plugin-deep-link = "2"
```

- [ ] **Step 2: Register the plugin in `lib.rs`**

```rust
let builder = tauri::Builder::default()
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_dialog::init())
    // … existing …
```

It's safe to register unconditionally — desktop will still receive deep-link events from the platforms that emit them (macOS / iOS / Android); Windows/Linux remain no-ops.

- [ ] **Step 3: JS package**

In repo root:

```bash
npm install @tauri-apps/plugin-deep-link
```

This adds the JS bridge.

- [ ] **Step 4: Capability grant**

The deep-link plugin needs permissions to call `onOpenUrl` and similar from JS. Create or extend `src-tauri/capabilities/mobile.json` (mobile-only capability set):

```json
{
  "$schema": "../gen/schemas/mobile-schema.json",
  "identifier": "mobile-base",
  "platforms": ["android", "iOS"],
  "windows": ["main"],
  "permissions": [
    "deep-link:default",
    "fs:allow-read-text-file"
  ]
}
```

If a capability file for the main window already exists and references the desktop permissions, leave that alone — the new file is additive.

- [ ] **Step 5: Verify desktop still builds**

```bash
cargo check
npm run tauri:build -- --bundles app
```

Both must pass — the deep-link crate is desktop-compatible.

**Commit:** `jj desc -m "Install tauri-plugin-deep-link for mobile share-sheet handling"`, then `jj new`.

---

## Task 2: Wire the launch intent

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/se/karleklund/marklig/MainActivity.kt`

The auto-generated `WryActivity` forwards `onNewIntent` to Rust but not the *launch* intent (the one carried in `onCreate`). For warm-launch share-target invocations, `onNewIntent` is sufficient. For cold-launch (the app wasn't running), the intent arrives at `onCreate` and must be relayed manually.

- [ ] **Step 1: Override `onCreate` in `MainActivity.kt`**

```kotlin
package se.karleklund.marklig

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Cold-launch ACTION_VIEW / ACTION_SEND arrives here, not in
    // onNewIntent. WryActivity's onNewIntent already relays to Rust
    // via Rust.onNewIntent. Replay the launch intent through the same
    // path so the deep-link plugin sees it.
    if (intent?.data != null || intent?.clipData != null) {
      onNewIntent(intent)
    }
  }
}
```

This re-routes the launch intent through `WryActivity.onNewIntent` → `Rust.onNewIntent` → the deep-link plugin's intent handler.

- [ ] **Step 2: Verify the intent path**

Sanity check: there's no existing onCreate override that this would conflict with. The auto-generated MainActivity.kt from task 1 step 5 of the step-1 plan already overrides onCreate just to call `enableEdgeToEdge()`. We're extending it.

**Commit:** `jj desc -m "Forward launch intent on Android cold start to deep-link plugin"`, then `jj new`.

---

## Task 3: `MobileFileShell` JS interface

**Files:**
- Create: `src/shell/mobile-fs.ts`

- [ ] **Step 1: Interface**

```ts
export interface MobileOpenedDoc {
  /** Stable opaque identifier — content URI on Android. */
  uri: string;
  /** Human-friendly name extracted from the URI's DocumentFile. */
  displayName: string;
  /** UTF-8 source. */
  source: string;
}

export interface MobileFileShell {
  /** Read a content URI's text. Throws on permission denied / not found. */
  readTextByUri(uri: string): Promise<string>;
  /** Resolve a DocumentFile's display name from a content URI. */
  displayNameFor(uri: string): Promise<string>;
  /** Persist a tree URI returned by ACTION_OPEN_DOCUMENT_TREE. Implementations
   *  call takePersistableUriPermission so the grant survives reboots. */
  persistTreeUri(treeUri: string): Promise<void>;
  /** List markdown files (recursive) under a previously-persisted tree URI.
   *  Returns content URIs the user can open via readTextByUri. */
  listMarkdownInTree(treeUri: string): Promise<Array<{ uri: string; displayName: string }>>;
  /** Trigger the SAF folder picker. Returns the tree URI the user picked,
   *  or null if cancelled. */
  pickTreeUri(): Promise<string | null>;
}
```

- [ ] **Step 2: Implementation backed by Tauri commands + plugin-fs**

```ts
import { invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";

class SafMobileFileShell implements MobileFileShell {
  async readTextByUri(uri: string): Promise<string> {
    // Tauri 2's plugin-fs resolves content:// URIs on Android via SAF when
    // the URI carries persistable permission (or temporary grant from an
    // ACTION_VIEW intent).
    return readTextFile(uri);
  }
  async displayNameFor(uri: string): Promise<string> {
    return invoke<string>("mobile_display_name", { uri });
  }
  async persistTreeUri(treeUri: string): Promise<void> {
    await invoke("mobile_persist_tree_uri", { treeUri });
  }
  async listMarkdownInTree(treeUri: string): Promise<Array<{ uri: string; displayName: string }>> {
    return invoke("mobile_list_markdown_in_tree", { treeUri });
  }
  async pickTreeUri(): Promise<string | null> {
    return invoke<string | null>("mobile_pick_tree_uri");
  }
}

export function createMobileFileShell(): MobileFileShell {
  return new SafMobileFileShell();
}
```

**Commit:** `jj desc -m "Add MobileFileShell interface + SAF implementation skeleton"`, then `jj new`.

---

## Task 4: Mobile Tauri commands

**Files:**
- Create: `src-tauri/src/commands/mobile_fs.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

These commands bridge to Android via JNI through Tauri's mobile plugin infrastructure. The implementation calls Kotlin helpers on the Android side.

- [ ] **Step 1: Command stubs in Rust**

```rust
// src-tauri/src/commands/mobile_fs.rs
//
// Mobile-only commands bridging to Android SAF / DocumentFile. Each calls
// a Kotlin counterpart in MainActivity (or a dedicated FsBridge object).
// See docs/superpowers/plans/2026-05-17-mobile-companion-2-saf-fileshell.md.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

#[derive(Serialize, Deserialize)]
pub struct MdFile {
    pub uri: String,
    pub display_name: String,
}

#[tauri::command]
pub async fn mobile_display_name<R: Runtime>(
    _app: AppHandle<R>,
    uri: String,
) -> Result<String, String> {
    // TODO call Kotlin via app.run_on_android_context. See task 5.
    Ok(uri.rsplit('/').next().unwrap_or("").to_string())
}

#[tauri::command]
pub async fn mobile_persist_tree_uri<R: Runtime>(
    _app: AppHandle<R>,
    _tree_uri: String,
) -> Result<(), String> {
    // TODO call Kotlin via app.run_on_android_context. See task 5.
    Ok(())
}

#[tauri::command]
pub async fn mobile_list_markdown_in_tree<R: Runtime>(
    _app: AppHandle<R>,
    _tree_uri: String,
) -> Result<Vec<MdFile>, String> {
    // TODO. See task 5.
    Ok(vec![])
}

#[tauri::command]
pub async fn mobile_pick_tree_uri<R: Runtime>(
    _app: AppHandle<R>,
) -> Result<Option<String>, String> {
    // TODO. See task 5.
    Ok(None)
}
```

- [ ] **Step 2: Module gating**

In `src-tauri/src/commands/mod.rs`:

```rust
#[cfg(mobile)]
pub mod mobile_fs;
```

In `src-tauri/src/lib.rs`, extend the mobile-only invoke handler:

```rust
#[cfg(mobile)]
let builder = builder.invoke_handler(tauri::generate_handler![
    take_pending_open_paths,
    commands::mobile_fs::mobile_display_name,
    commands::mobile_fs::mobile_persist_tree_uri,
    commands::mobile_fs::mobile_list_markdown_in_tree,
    commands::mobile_fs::mobile_pick_tree_uri,
]);
```

**Commit:** `jj desc -m "Mobile Tauri command stubs for SAF bridge"`, then `jj new`.

---

## Task 5: Kotlin bridge for SAF

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/se/karleklund/marklig/MainActivity.kt`

Each Rust command in task 4 needs a Kotlin counterpart that does the actual SAF work. Tauri Mobile's plugin pattern is the formal way; for step 2 we use a simpler bridge: a singleton companion object on `MainActivity` exposed as JNI functions, with Rust calling via `tauri::mobile::PluginHandle::run_mobile_plugin`.

The cleanest packaging for this is a dedicated Tauri plugin module under `src-tauri/src/plugin_mobile_fs.rs` + a Kotlin class. For step 2 keep it minimal: in `MainActivity.kt`, expose static methods `displayNameFor(uri: String): String`, `persistTreeUri(treeUri: String)`, `listMarkdownInTree(treeUri: String): String` (returns JSON), `pickTreeUri(): String?`.

- [ ] **Step 1: Sketch the Kotlin object**

```kotlin
package se.karleklund.marklig

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject

object MobileFsBridge {
  private lateinit var appContext: Context
  fun bind(ctx: Context) { appContext = ctx }

  fun displayName(uriStr: String): String {
    val uri = Uri.parse(uriStr)
    val doc = DocumentFile.fromSingleUri(appContext, uri)
    return doc?.name ?: uri.lastPathSegment ?: uriStr
  }

  fun persistTreeUri(treeUriStr: String) {
    val uri = Uri.parse(treeUriStr)
    val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
    appContext.contentResolver.takePersistableUriPermission(uri, flags)
  }

  fun listMarkdownInTree(treeUriStr: String): String {
    val tree = DocumentFile.fromTreeUri(appContext, Uri.parse(treeUriStr))
      ?: return "[]"
    val out = JSONArray()
    fun walk(node: DocumentFile) {
      for (child in node.listFiles()) {
        if (child.isDirectory) { walk(child); continue }
        val name = child.name ?: continue
        if (!isMarkdown(name)) continue
        val obj = JSONObject()
        obj.put("uri", child.uri.toString())
        obj.put("displayName", name)
        out.put(obj)
      }
    }
    walk(tree)
    return out.toString()
  }

  private fun isMarkdown(name: String): Boolean {
    val lower = name.lowercase()
    return lower.endsWith(".md") || lower.endsWith(".markdown") ||
           lower.endsWith(".mdx") || lower.endsWith(".mdown")
  }
}
```

- [ ] **Step 2: Folder picker activity result**

The SAF folder picker is an Activity-for-result: launch `Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)`, receive the URI in `onActivityResult`. Use the AndroidX `ActivityResultContracts.OpenDocumentTree` contract.

In `MainActivity.kt`:

```kotlin
private val openTreeLauncher = registerForActivityResult(
  androidx.activity.result.contract.ActivityResultContracts.OpenDocumentTree()
) { uri: Uri? ->
  pickTreePromise?.complete(uri?.toString())
  pickTreePromise = null
}

private var pickTreePromise: kotlinx.coroutines.CompletableDeferred<String?>? = null

suspend fun pickTreeUri(): String? {
  val deferred = kotlinx.coroutines.CompletableDeferred<String?>()
  pickTreePromise = deferred
  openTreeLauncher.launch(null)
  return deferred.await()
}
```

(If `kotlinx-coroutines-core` isn't already on the classpath, add it as a Gradle dep in `app/build.gradle.kts`.)

- [ ] **Step 3: JNI plumbing**

This is the bit that's specific to Tauri Mobile and depends on plugin scaffolding. The straightforward path is to wrap `MobileFsBridge` as a Tauri Mobile plugin (`tauri::plugin::Builder` plus `tauri::android::plugin!(MobileFs)` macro). Rust commands then dispatch to the plugin via `app.run_mobile_plugin<MobileFs, _, _>(...)`.

Reference Tauri docs: https://tauri.app/develop/calling-rust/#mobile-plugins and the `tauri-plugin-dialog` source as a working example.

**Stop here** if Tauri 2.11's plugin macros require a separate `tauri-plugin-fs-mobile` crate / build step you'd rather avoid in a single step. Fallback: keep the Rust commands as stubs that return TODOs, document the gap in step 2's smoke notes, and unblock step 3 by hardcoding a single bundled doc in the library for visual verification.

**Commit:** `jj desc -m "Kotlin SAF bridge for the MobileFileShell command surface"`, then `jj new`.

---

## Task 6: Listen for deep-link events in mobile-bootstrap

**Files:**
- Modify: `src/mobile-bootstrap.ts`

- [ ] **Step 1: Subscribe to onOpenUrl**

```ts
import { onOpenUrl, getCurrent as getCurrentDeepLink } from "@tauri-apps/plugin-deep-link";
import { createMobileFileShell } from "./shell/mobile-fs";

// inside mobileBootstrap, after the EditorView is created:

const fs = createMobileFileShell();

async function openUri(uri: string): Promise<void> {
  const source = await fs.readTextByUri(uri);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: source },
  });
  // Persist as the last-opened so step 3's recents picks it up.
  await import("./shell/store").then(({ setValue }) => setValue("mobile.lastOpenedUri", uri));
}

// Cold-launch URIs.
const initial = await getCurrentDeepLink();
if (initial && initial.length > 0) {
  await openUri(initial[0]);
}

// Warm-launch / subsequent shares.
await onOpenUrl(async (urls) => {
  if (urls.length > 0) await openUri(urls[0]);
});
```

The `?? sampleSource` fallback to the bundled sample remains: if no URI is present at startup and no `mobile.lastOpenedUri` is persisted, we keep showing `sample.md`.

- [ ] **Step 2: Restore last-opened on warm start (no intent)**

```ts
if (!initial) {
  const stored = await getValue<string>("mobile.lastOpenedUri");
  if (stored) {
    try { await openUri(stored); } catch { /* URI may have been revoked */ }
  }
}
```

**Commit:** `jj desc -m "Open shared / launched content URIs from mobile bootstrap"`, then `jj new`.

---

## Task 7: Smoke test the share-sheet flow

**Files:** none (verification)

- [ ] **Step 1: Build and install**

```bash
npm run tauri:android:dev
```

Wait for the app to launch with `sample.md` rendered.

- [ ] **Step 2: Side-load an `.md` to the device**

```bash
echo "# Hello from share sheet\n\nThis came from another app." > /tmp/shared.md
adb push /tmp/shared.md /sdcard/Download/shared.md
```

- [ ] **Step 3: Open from Files**

On the phone: Files app → Downloads → tap `shared.md`. The system should show an open-with picker that includes Märklig. Tap Märklig.

Expected: the app foregrounds (or relaunches) and `shared.md`'s content replaces the bundled sample.

- [ ] **Step 4: Share from another app**

Open the same file in any text editor → Share → Märklig. Same expected result.

- [ ] **Step 5: Cold-start the flow**

Force-stop the app (Settings → Apps → Märklig → Force stop), then open the file from Files again. Cold-launch path should also render the shared doc.

- [ ] **Step 6: Capture artifacts**

```bash
adb exec-out screencap -p > docs/images/android-step2-share-sheet.png
```

Attach to the step-2 PR.

**Commit:** None if no code fixes were needed; otherwise `jj desc -m "Fix <specific> in mobile share-sheet flow"` per finding.

---

## Task 8: Folder picker + library indexing (lite)

**Files:** none new — exercises the existing surface via a stub UI.

- [ ] **Step 1: Add a one-tap "Pick folder" affordance**

Until step 3 lands the real library UI, mount a small floating button in mobile-bootstrap that calls `fs.pickTreeUri()` then `fs.listMarkdownInTree(uri)` and logs the count to the console.

```ts
const pickBtn = document.createElement("button");
pickBtn.textContent = "Pick folder";
pickBtn.style.cssText = "position:fixed;top:8px;right:8px;z-index:1000;padding:8px;";
pickBtn.onclick = async () => {
  const tree = await fs.pickTreeUri();
  if (!tree) return;
  await fs.persistTreeUri(tree);
  const files = await fs.listMarkdownInTree(tree);
  console.log(`Found ${files.length} markdown files`);
  // For smoke verification, also open the first one if any.
  if (files.length > 0) await openUri(files[0].uri);
};
root.appendChild(pickBtn);
```

This is throwaway UI — step 3 replaces it with the library home.

- [ ] **Step 2: Smoke**

Push a folder of `.md` files to the device:

```bash
adb shell mkdir -p /sdcard/Documents/marklig-test
adb push tests/parser/fixtures/*.md /sdcard/Documents/marklig-test/ 2>/dev/null || true
echo "# A\n\n## B" > /tmp/a.md
adb push /tmp/a.md /sdcard/Documents/marklig-test/a.md
```

In the app, tap "Pick folder" → navigate to Documents/marklig-test → pick. Console should log a count > 0; the first file should render.

- [ ] **Step 3: Persistence across launches**

Force-stop and relaunch. The persisted tree URI should still be valid (it isn't auto-listed yet; step 3's library does that), but `fs.persistTreeUri` should have called `takePersistableUriPermission` so SAF doesn't reject `listMarkdownInTree` on relaunch. Verify by tapping "Pick folder" again — picker should open without "permission denied" toasts.

**Commit:** `jj desc -m "Throwaway folder-pick affordance for step 2 smoke"`, then `jj new`. Step 3 removes this in favor of the real library.

---

## Task 9: Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Note the MobileFileShell in CLAUDE.md**

Append to the "Mobile target" section:

```markdown
The mobile file shell is JS-only in shape (`src/shell/mobile-fs.ts`),
backed by Tauri commands (`src-tauri/src/commands/mobile_fs.rs`) that
delegate to Kotlin (`MobileFsBridge` in `MainActivity.kt`). URIs are
opaque IDs — never derive paths from them. SAF tree URIs are persisted
via `takePersistableUriPermission` so grants survive reboot.
```

- [ ] **Step 2: ROADMAP step 2 → ✅**

```markdown
- [x] Step 2 — SAF MobileFileShell + share-sheet handler (PR #__)
```

**Commit:** `jj desc -m "Document mobile file shell surface"`, then `jj new`.

---

## Final checks

- [ ] Steps 1–9 committed as separate jj revisions on `issue-70-mobile-step2`.
- [ ] Desktop build untouched (`cargo check`, `npm run tauri:build -- --bundles app`).
- [ ] Android `npm run tauri:android:dev` runs the app, share-sheet flow works.
- [ ] PR opened against `trunk` (or stacked on the step-1 PR), depending on review order.

## What this plan does NOT deliver

- No library / recents UI (step 3).
- No release build / signing.
- No iOS.
- The Rust↔Kotlin plumbing in task 5 may end up partially stubbed if Tauri 2.11's mobile-plugin macros require more scaffolding than fits inside this step — in that case, document the stub in the PR description and treat step 3 as the gate for the missing bits.
