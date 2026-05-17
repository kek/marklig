# Mobile companion — Step 1: Tauri Android init

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Android target to the existing Tauri project so the existing webview frontend (CodeMirror 6 + decoration producers + markdown-it + Shiki + KaTeX + Mermaid) runs in an Android emulator and renders a hard-coded `sample.md`. No file-shell work yet; no sync; no library UI. Just: prove the renderer ports cleanly to Android WebView.

**Architecture:** `tauri android init` scaffolds `src-tauri/gen/android/` (Gradle project + Kotlin entry-point + JNI bridge) alongside the existing `src-tauri/gen/schemas` and `src-tauri/macos`. The frontend Vite build is shared verbatim. Conditional Rust code (file shell, watcher, NSDocumentController recents) is gated behind `#[cfg(desktop)]` so the Android build skips it.

**Tech Stack:** Existing Tauri 2.x + Vite + TypeScript. New: Android Gradle Plugin 8.x (managed by Tauri scaffolding), Kotlin (entry-point only), `aarch64-linux-android` Rust target (already installed).

**Spec:** `docs/superpowers/specs/2026-05-17-mobile-companion-design.md` — see §11 step 1, §5 (renderer reuse), §12 (Tauri Mobile maturity risk).

**VCS note:** This repository is a Jujutsu (`.jj/`) repo. Commits use `jj`, not `git`. Pattern: stage all edits in the working copy, then `jj desc -m "…"` to set the message and `jj new` to roll forward to the next task. Never run raw `git commit` here.

---

## Scope boundaries

In scope:
- Android target scaffolding via `tauri android init`
- Conditional-compilation gating so existing desktop-only Rust code is excluded from the Android build
- A single hard-coded `sample.md` baked into the frontend bundle, rendered on app launch (no file picking, no recents)
- npm scripts for the Android dev loop: `tauri:android:dev`, `tauri:android:build`
- Mobile-specific CSS adjustments minimal enough to make the existing reading mode legible on a phone (viewport meta, touch-friendly tap targets are *not* in scope — leave for step 2)
- Emulator smoke test documented in README / dev notes

Out of scope (own steps later):
- SAF file shell (step 2)
- Share-sheet handling (step 2)
- Library / recents UI (step 3)
- Crypto, pairing, sync (steps 4–7)
- Play Store signing, release builds, .aab production (covered partly here only to the extent of debug-build configuration; release signing deferred)
- iOS

---

## File structure

```
viewer/
├── src-tauri/
│   ├── Cargo.toml                              (mod) add [lib] crate-type, mobile-relevant features
│   ├── tauri.conf.json                         (mod) bundle.android.minSdkVersion, identifier review
│   ├── src/
│   │   ├── lib.rs                              (mod) gate desktop-only init behind cfg(desktop); add mobile_entry_point
│   │   └── commands/                           (mod) gate desktop-only commands behind cfg(desktop)
│   └── gen/
│       └── android/                            (NEW, scaffolded by `tauri android init`)
├── src/
│   ├── main.ts                                 (mod) on mobile, load sample.md instead of running desktop bootstrap
│   ├── sample.md                               (NEW) bundled smoke-test document
│   └── platform.ts                             (NEW) `isMobile()` runtime check
├── package.json                                (mod) tauri:android:dev / :build scripts
├── README.md                                   (mod) Android dev-loop section
├── CLAUDE.md                                   (mod) note Android target exists, document cfg(desktop) split
└── ROADMAP.md                                  (mod) add v2 sub-spec note: "Mobile companion: step 1 (Android init) ✅"
```

---

## Task 1: Confirm and prepare toolchain

**Files:** none (verification + env wiring)

- [ ] **Step 1: Verify toolchain presence**

Run and capture output (these are expected to succeed):
```bash
java -version                       # JDK 17+ required (project has JDK 25 — fine)
echo $ANDROID_HOME                  # must point at a valid SDK dir
ls $ANDROID_HOME/ndk                # must contain at least one NDK version
ls $ANDROID_HOME/platforms          # must contain android-34 or higher
rustup target list --installed | grep android   # must include aarch64-linux-android
npx tauri --version                 # must be >= 2.0
```

If any check fails, stop and surface to the user before proceeding — the rest of this plan assumes them.

- [ ] **Step 2: Export `NDK_HOME`**

Tauri Android needs `NDK_HOME` (or `ANDROID_NDK_HOME`). Add to the developer's shell rc (fish: `~/.config/fish/config.fish`):
```fish
set -gx NDK_HOME "$ANDROID_HOME/ndk/"(ls "$ANDROID_HOME/ndk" | tail -1)
```
Or for bash/zsh:
```sh
export NDK_HOME="$ANDROID_HOME/ndk/$(ls $ANDROID_HOME/ndk | tail -1)"
```

This is environment, not committed code. Document the requirement in README; do not bake a specific NDK version path into any tracked file.

- [ ] **Step 3: Add additional Rust Android targets**

For arm64 emulator on Apple Silicon, `aarch64-linux-android` is enough. For broader device coverage in eventual release builds, also install:
```bash
rustup target add armv7-linux-androideabi x86_64-linux-android i686-linux-android
```
This is local-environment-only — not tracked in any file — but document it in the README dev-loop section (Task 7).

**Commit:** None (env-only).

---

## Task 2: Gate desktop-only Rust code behind `cfg(desktop)`

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: every module under `src-tauri/src/commands/` and `src-tauri/src/` that imports desktop-only crates (`notify`, `notify-debouncer-full`, `objc2`, etc.)

The Cargo `desktop` cfg is set automatically by Tauri when building for desktop targets; `mobile` is set on Android/iOS. We use `#[cfg(desktop)]` on entire modules / fns and `#[cfg(mobile)]` on mobile-specific paths.

- [ ] **Step 1: Audit imports**

Run:
```bash
grep -rn "use notify\|use objc2\|use notify_debouncer" src-tauri/src/
```
Every hit identifies a module that must be gated. Likely candidates per CLAUDE.md: the watcher module (notify-debouncer-full), the `recents_os.rs` (objc2 NSDocumentController), the `reveal_in_file_manager` command.

- [ ] **Step 2: Gate at the `mod` boundary**

In `src-tauri/src/lib.rs` (and any other parent module declaring these), wrap the relevant `mod` declarations:
```rust
#[cfg(desktop)]
mod watcher;
#[cfg(desktop)]
mod recents_os;
```
And similarly gate any `commands::watcher_start`-style invoke handler registrations behind `#[cfg(desktop)]` in the builder chain.

- [ ] **Step 3: Add `mobile_entry_point` stub**

In `src-tauri/src/lib.rs`, add a `#[cfg_attr(mobile, tauri::mobile_entry_point)]` attribute on the `pub fn run()` function (Tauri Mobile generates the Android JNI entry-point from this).

- [ ] **Step 4: Verify desktop build still succeeds**

```bash
cd src-tauri && cargo check
npm run tauri:build -- --bundles app
```
Both must pass. This is the gate before adding the Android target. If desktop breaks, the gating is wrong.

**Verification (before commit):**
- [ ] `cargo check` clean
- [ ] `npm run tauri:build -- --bundles app` clean
- [ ] No previously-working desktop feature regressed (smoke: open the app, open an `.md`, edit and save it)

**Commit:** `jj desc -m "Gate desktop-only Tauri code behind cfg(desktop)"`, then `jj new`.

---

## Task 3: Add a platform-detection helper and a bundled sample doc

**Files:**
- Create: `src/platform.ts`
- Create: `src/sample.md`

- [ ] **Step 1: `src/platform.ts`**

```ts
import { isTauri } from "@tauri-apps/api/core";

export function isMobile(): boolean {
  // Tauri Mobile exposes platform via the OS plugin; for the v2.0 init step we
  // detect via user-agent which is sufficient to fork the bootstrap path.
  // Replace with the OS plugin in step 2 when we wire `@tauri-apps/plugin-os`.
  if (!isTauri()) return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("android");
}
```

- [ ] **Step 2: `src/sample.md`**

A ~30-line Markdown document exercising the major decoration producers (headings of multiple levels, a list, a blockquote, a code fence with a language Shiki supports, a link, bold/italic, an inline-code span, a math expression like `$E = mc^2$`, and a small Mermaid diagram). Pick prose that fits a "hello world" framing — this is what someone seeing the Android app for the first time will see.

**Verification:** none (no behavior change yet — these files are wired up in task 4).

**Commit:** `jj desc -m "Add platform helper and bundled sample.md for Android smoke test"`, then `jj new`.

---

## Task 4: Bootstrap fork for Android in `src/main.ts`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Identify the desktop bootstrap entry point**

Read `src/main.ts` and locate the existing `bootstrap()` (or equivalent) call that initializes recents, recovery, watcher, and the file-association `file-open-request` listener.

- [ ] **Step 2: Fork**

At the top of `main.ts` (after CSS imports and before the desktop bootstrap call), add:

```ts
import { isMobile } from "./platform";
import sampleSource from "./sample.md?raw";

if (isMobile()) {
  // v2.0 step 1 — no file shell on mobile yet; show the bundled sample doc.
  const editor = await createEditor({ source: sampleSource, readOnly: true });
  document.getElementById("app")!.appendChild(editor.dom);
} else {
  await desktopBootstrap();
}
```

(Exact symbol names depend on what the existing entry point exports; adapt to match. If `createEditor` is not currently the public surface, factor a minimal `createReadingEditor(source)` out of the existing reading-mode init path. Do not duplicate decoration-producer wiring.)

- [ ] **Step 3: Vite raw-text import**

Add `"*.md"` to the `import` types declaration so `?raw` typechecks (if not already covered by Vite's `client.d.ts`). Check `src/vite-env.d.ts` and extend if needed:

```ts
declare module "*.md?raw" {
  const src: string;
  export default src;
}
```

**Verification:**
- [ ] `npx tsc -b --noEmit` clean
- [ ] `npm run dev` still opens the desktop frontend correctly in a browser (mobile branch is skipped — `isTauri()` is false in `npm run dev`)
- [ ] `npm run tauri:dev` still launches the desktop app normally

**Commit:** `jj desc -m "Fork bootstrap to render bundled sample.md on Android"`, then `jj new`.

---

## Task 5: Scaffold the Android target via `tauri android init`

**Files generated (do not hand-write):**
- Create: `src-tauri/gen/android/**` (Gradle project + Kotlin entry-point + manifest)
- Modify: `src-tauri/Cargo.toml` (Tauri CLI adds `[lib] crate-type = ["staticlib", "cdylib", "rlib"]` if missing)
- Modify: `src-tauri/tauri.conf.json` (Tauri CLI may add `bundle.android.*` keys)

- [ ] **Step 1: Confirm bundle identifier suits Android**

Open `src-tauri/tauri.conf.json` and verify `identifier` is reverse-DNS (Android requires this). If it currently looks like `com.tv4.marklig` or similar reverse-DNS, fine. If it's a placeholder like `tauri.app.marklig`, change it to a stable real identifier (e.g. `com.marklig.app`) *before* running `init` — changing it after means renaming generated packages.

- [ ] **Step 2: Run init**

```bash
cd src-tauri
NDK_HOME="$ANDROID_HOME/ndk/$(ls $ANDROID_HOME/ndk | tail -1)" cargo tauri android init
```

This creates `src-tauri/gen/android/` containing:
- `app/build.gradle.kts`
- `app/src/main/AndroidManifest.xml`
- `app/src/main/java/<reverse-dns>/MainActivity.kt`
- `gradle/`, `gradlew`, `gradlew.bat`
- `settings.gradle.kts`

- [ ] **Step 3: Inspect generated `tauri.conf.json` diff**

Tauri CLI may add a `bundle.android` block. Review it; do not commit secrets if any were generated.

- [ ] **Step 4: Make `src-tauri/Cargo.toml` reproducible**

Tauri CLI typically adds `[lib] crate-type = ["staticlib", "cdylib", "rlib"]`. Confirm that block is present and committed. Add any feature flags Tauri added (e.g. `tauri/desktop` / `tauri/mobile`) — these are required for the conditional compilation in Task 2 to work.

- [ ] **Step 5: `.gitignore` the build outputs**

Add to repo root `.gitignore` (or extend `src-tauri/.gitignore`):
```
src-tauri/gen/android/.gradle/
src-tauri/gen/android/build/
src-tauri/gen/android/app/build/
src-tauri/gen/android/local.properties
src-tauri/gen/android/.idea/
```
Do NOT ignore `src-tauri/gen/android/` wholesale — the Kotlin entry-point and Gradle config must be tracked.

**Verification:**
- [ ] `src-tauri/gen/android/` exists and contains `app/src/main/AndroidManifest.xml`
- [ ] Desktop build still works: `npm run tauri:build -- --bundles app`

**Commit:** `jj desc -m "Scaffold Android target via tauri android init"`, then `jj new`.

---

## Task 6: First build and emulator smoke test

**Files:** none (validation step)

- [ ] **Step 1: Start an emulator**

The Android Studio AVD Manager (or `emulator -avd <name>`) must have at least one running ARM64 AVD. The developer running this plan must do that — agent cannot launch a GUI emulator.

Verify with:
```bash
adb devices
```
Output should list one online emulator.

- [ ] **Step 2: First Android dev run**

```bash
NDK_HOME="$ANDROID_HOME/ndk/$(ls $ANDROID_HOME/ndk | tail -1)" \
  npx tauri android dev
```

This:
1. Builds the Rust library for `aarch64-linux-android`.
2. Builds Vite frontend.
3. Builds the Gradle Android app.
4. Installs onto the emulator.
5. Tail-logs from the emulator.

First build takes minutes (downloading Gradle, AGP, Android SDK build-tools — Tauri's gradle wrapper may pull them).

- [ ] **Step 3: Visual smoke test**

In the emulator, the Märklig app should launch and display the rendered `sample.md` in reading mode. Confirm:
- Headings render with the project typography
- Code fence highlights via Shiki (this is the first proof the async highlight pipeline works on Android WebView)
- Math expression renders via KaTeX
- Mermaid diagram renders (this is the largest async dep; if it fails on Android it usually means a `import("mermaid")` resolution issue — debug that)

Take a screenshot via `adb exec-out screencap -p > emulator-smoke.png` and attach to the PR.

- [ ] **Step 4: Document expected platform differences**

Visual-regression baselines from `tests/e2e/visual-regression.spec.ts` are desktop-only. Do NOT generate Android baselines yet — that's a step 3 concern when there's a library UI to anchor them to. The smoke screenshot is the only artifact at this stage.

**Verification:**
- [ ] App launches without a redbox / crash on the emulator
- [ ] `sample.md` renders with prose, code-fence highlighting, math, and the Mermaid diagram visible
- [ ] No console errors in `adb logcat` related to missing JS resources

**Commit:** None for the smoke test itself; if any code fixes were needed to make it work, those land as `jj desc -m "Fix <specific thing> on Android WebView"`.

---

## Task 7: Dev-loop wrapper scripts and docs

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: npm scripts**

Add to `package.json` `"scripts"`:
```json
"tauri:android:dev": "tauri android dev",
"tauri:android:build": "tauri android build",
"tauri:android:build:debug": "tauri android build --debug"
```

These intentionally rely on `NDK_HOME` being in the shell env — the README documents that.

- [ ] **Step 2: README "Android dev loop" section**

Add a section after the existing dev-loop instructions:

```markdown
## Android (mobile companion — v2.0, work in progress)

### One-time setup
1. Install Android Studio → run AVD Manager → create an ARM64 AVD on API 34+.
2. Install NDK via Android Studio SDK Manager.
3. In shell rc, export:
   ```
   export NDK_HOME="$ANDROID_HOME/ndk/$(ls $ANDROID_HOME/ndk | tail -1)"
   ```
4. Install Android Rust targets:
   ```
   rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android
   ```

### Dev loop
1. Launch an emulator from Android Studio.
2. Verify it's online: `adb devices`.
3. Run `npm run tauri:android:dev`.

The first build takes several minutes (Gradle download). Subsequent rebuilds are fast.

### Status
Currently renders a bundled sample document only — no file picking, no share-sheet integration, no sync. See `docs/superpowers/specs/2026-05-17-mobile-companion-design.md`.
```

- [ ] **Step 3: CLAUDE.md note**

Add a short paragraph in CLAUDE.md after the existing "Rust shell" section explaining the `cfg(desktop)` split and that `src-tauri/gen/android/` is tracked:

```markdown
### Mobile target

`src-tauri/gen/android/` is tracked. Desktop-only Rust code (watcher, recents_os, file-shell commands) is gated behind `#[cfg(desktop)]`. Mobile-only entry points use `#[cfg(mobile)]` or `#[cfg_attr(mobile, tauri::mobile_entry_point)]`. When adding new commands, default to gating them desktop-only unless they're explicitly designed for both — Android does not have an FS watcher and does not have NSDocumentController.
```

- [ ] **Step 4: ROADMAP.md note**

Add under the v2 / mobile companion section (creating it if absent):
```markdown
## v2 — Mobile companion

Spec: `docs/superpowers/specs/2026-05-17-mobile-companion-design.md`. Tracking issue #70.

- [x] Step 1 — Tauri Android init (PR #__)
- [ ] Step 2 — SAF MobileFileShell + share-sheet handler
- [ ] Step 3 — Recents + library UI (v2.0-alpha ship)
- [ ] Step 4 — Crypto core (Noise XK + envelope + sync ops)
- [ ] Step 5 — Desktop pairing UX
- [ ] Step 6 — LAN transport (mDNS + TCP/WebRTC)
- [ ] Step 7 — Phone pairing UX + sync wire-up
- [ ] Step 8 — Soft launch (v2.0)
```

**Verification:**
- [ ] `npm run tauri:android:dev` runs (assuming env + emulator) without npm-script-level errors
- [ ] Markdown renders in README/CLAUDE/ROADMAP without broken links
- [ ] `npx tsc -b --noEmit` still clean

**Commit:** `jj desc -m "Document Android dev loop and add npm scripts"`, then `jj new`.

---

## Final checks

- [ ] All seven tasks committed as separate jj revisions on a single bookmark
- [ ] Desktop build untouched in behavior (smoke: open + edit + save an `.md`)
- [ ] Android emulator smoke test passed
- [ ] PR opened against `trunk` linking #70 and depending on PR #81 (the spec)
- [ ] Screenshot of the rendered `sample.md` on the emulator attached to the PR

## What this plan does NOT deliver

- No file picking on Android (step 2)
- No share-sheet handling (step 2)
- No library UI / recents (step 3)
- No release build, no signing, no Play Store submission
- No iOS
- No visual-regression baselines for Android (deferred to step 3)
- No verification of release-build symbol stripping / R8 minification behavior — debug build only

These are intentional. Step 1 proves the renderer ports. The rest is shell work that depends on it.
