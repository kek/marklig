// Mobile (Android) bootstrap. Step 3 of the v2 mobile companion: library
// home + recents + back-button navigation. The renderer is the same as
// desktop reading mode (CodeMirror 6 + the decoration-producer set);
// only the shell is mobile-specific.
//
// Routing is a 2-state machine: { kind: "library" } | { kind: "document" }.
// Renders are destructive — switching routes destroys the current
// EditorView (if any) and re-mounts into #root. Cache-effect
// subscriptions are recreated per document mount so we don't accumulate.
//
// Cold-launch URI takes precedence over a populated recents list — if
// the OS sent us here to handle a share intent, we honor it immediately.

import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";

import { buildDecorationField } from "./editor/decorations";
import { headingsProducer } from "./editor/decorations/headings";
import { inlineProducer } from "./editor/decorations/inline";
import { listsProducer } from "./editor/decorations/lists";
import { linksProducer } from "./editor/decorations/links";
import { imagesProducer } from "./editor/decorations/images";
import { blockquotesProducer } from "./editor/decorations/blockquotes";
import { tablesProducer } from "./editor/decorations/tables";
import {
  codeblocksProducer,
  primeHighlighter,
  highlightCache,
  highlightCacheEffect,
} from "./editor/decorations/codeblocks";
import { frontmatterProducer } from "./editor/decorations/frontmatter";
import { footnotesProducer } from "./editor/decorations/footnotes";
import { readingWidgetsProducer } from "./editor/decorations/reading-widgets";
import { mathProducer } from "./editor/decorations/math";
import {
  mermaidProducer,
  mermaidCache,
  mermaidCacheEffect,
} from "./editor/decorations/mermaid";
import {
  graphvizProducer,
  graphvizCache,
  graphvizCacheEffect,
} from "./editor/decorations/graphviz";
import { loadSettings } from "./shell/settings";
import {
  applyTheme,
  loadStoredTheme,
  watchSystemTheme,
} from "./editor/theme";
import { detectFormat } from "./format";
import {
  onOpenUrl,
  getCurrent as getCurrentDeepLinkUrls,
} from "@tauri-apps/plugin-deep-link";
import { readTextFile } from "@tauri-apps/plugin-fs";
import {
  loadRecents,
  recordRecent,
  uriDisplayName,
} from "./shell/mobile-recents";
import { mountMobileLibrary } from "./ui/mobile-library";
import {
  listMobilePairings,
  type MobilePairing,
  startSyncClient,
  stopSyncClient,
  readSyncedFile,
} from "./shell/mobile-pairings";
import {
  mountMobilePairForm,
  showMobilePairSuccess,
} from "./ui/mobile-pair-form";
import { LIVE_OP_EVENT } from "./shell/mobile-sync-client";
import { mountMobileSynced } from "./ui/mobile-synced-view";
import { t } from "./i18n/strings";

import sampleSource from "./sample.md?raw";
import "katex/dist/katex.min.css";
import "./styles-mobile.css";

type Route =
  | { kind: "library" }
  | { kind: "document"; source: string; uriForRecents?: string }
  | { kind: "pair" }
  | { kind: "synced"; pairing: MobilePairing };

/**
 * Decide what the Android system back-button should do given the
 * currently rendered route. Pure for testability — the boostrap wires
 * this to the native `OnBackPressedCallback` via a global function the
 * webview exposes to MainActivity (issue #96).
 *
 * Returns:
 *   { handled: true, next: <route> }  — JS pops to `next`; Android is told the press was consumed.
 *   { handled: false }                — JS does nothing; Android backgrounds the task (exit-like).
 */
export type AndroidBackDecision =
  | { handled: true; next: Route }
  | { handled: false };

export function decideAndroidBack(route: Route): AndroidBackDecision {
  switch (route.kind) {
    case "document":
      // The document route ALWAYS renders an on-screen "← Back" bar to the
      // library (see renderRoute — even the first-launch bundled-sample
      // view shows it). The hardware back button must agree with that
      // affordance, so it pops to the library unconditionally rather than
      // backgrounding the app on the sample view.
      return { handled: true, next: { kind: "library" } };
    case "pair":
    case "synced":
      return { handled: true, next: { kind: "library" } };
    case "library":
      return { handled: false };
  }
}

export async function mobileBootstrap(): Promise<void> {
  applyTheme(loadStoredTheme());
  watchSystemTheme(() => applyTheme(loadStoredTheme()));
  await loadSettings();

  // Prime Shiki for a broad set of languages so user-opened docs colorize
  // without waiting for an on-demand load. Matches the desktop bootstrap.
  await primeHighlighter([
    "javascript", "typescript", "python", "go", "rust",
    "java", "c", "cpp", "shell", "json", "yaml", "sql",
    "html", "css", "markdown",
  ]);

  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  root.innerHTML = "";

  let currentView: EditorView | null = null;
  let viewCleanups: Array<() => void> = [];
  let currentSyncedFile: {
    pairIdHex: string;
    folderIdHex: string;
    relpath: string;
  } | null = null;
  // Mirror of the most recently rendered route. The Android back-press
  // bridge (see `__marklig_android_back` below) reads this synchronously
  // to decide whether to pop to library or let Android background the
  // task. Treat as read-only outside `renderRoute`.
  let currentRoute: Route = { kind: "library" };

  const renderRoute = async (route: Route): Promise<void> => {
    currentRoute = route;
    // Tear down whatever is mounted.
    for (const fn of viewCleanups) {
      try { fn(); } catch { /* no-op */ }
    }
    viewCleanups = [];
    if (currentView) {
      currentView.destroy();
      currentView = null;
    }
    root.innerHTML = "";

    if (route.kind === "library") {
      const [recents, pairings] = await Promise.all([
        loadRecents(),
        listMobilePairings(),
      ]);
      mountMobileLibrary(root, recents, pairings, {
        onOpenRecent: async (uri) => {
          try {
            const source = await readTextFile(uri);
            await renderRoute({
              kind: "document",
              source,
              uriForRecents: uri,
            });
          } catch (err) {
            console.error("failed to reopen recent", uri, err);
          }
        },
        onPairTap: () => {
          void renderRoute({ kind: "pair" });
        },
        onPairedDesktopTap: (pairing) => {
          void renderRoute({ kind: "synced", pairing });
        },
      });
      return;
    }

    if (route.kind === "pair") {
      mountMobilePairForm(root, {
        onPaired: (result) => {
          showMobilePairSuccess(root, result, () => {
            void renderRoute({ kind: "library" });
          });
        },
        onCancel: () => {
          void renderRoute({ kind: "library" });
        },
      });
      return;
    }

    if (route.kind === "synced") {
      const teardown = await mountMobileSynced(root, route.pairing, {
        onOpenFile: async (file) => {
          try {
            const source = await readSyncedFile(
              file.pair_id_hex,
              file.folder_id_hex,
              file.relpath,
            );
            currentSyncedFile = {
              pairIdHex: file.pair_id_hex,
              folderIdHex: file.folder_id_hex,
              relpath: file.relpath,
            };
            await renderRoute({ kind: "document", source });
          } catch (err) {
            console.error("failed to open synced file", file, err);
          }
        },
        onBack: () => {
          currentSyncedFile = null;
          void renderRoute({ kind: "library" });
        },
        onUnpaired: () => {
          currentSyncedFile = null;
          void renderRoute({ kind: "library" });
        },
      });
      viewCleanups.push(() => {
        teardown();
        stopSyncClient(route.pairing.pair_id_hex);
      });
      startSyncClient(route.pairing);
      return;
    }

    // Document view — back-bar + editor mount. Always show the back-bar
    // so the user can reach the library (and the pair-with-a-desktop
    // CTA) from anywhere, including the first-launch bundled-sample
    // view.

    // Guard: Typst documents are not renderable on mobile (no compile engine).
    if (route.uriForRecents && detectFormat(route.uriForRecents) === "typst") {
      const wrap = document.createElement("div");
      wrap.className = "mobile-document";
      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.className = "mobile-document__back";
      backBtn.textContent = "← " + t("mobile.library.back");
      backBtn.addEventListener("click", () => {
        void renderRoute({ kind: "library" });
      });
      wrap.appendChild(backBtn);
      const msg = document.createElement("p");
      msg.className = "mobile-document__unsupported";
      msg.textContent = t("typst.unsupported_on_mobile");
      wrap.appendChild(msg);
      root.appendChild(wrap);
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "mobile-document";

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "mobile-document__back";
    backBtn.textContent = "← " + t("mobile.library.back");
    backBtn.addEventListener("click", () => {
      void renderRoute({ kind: "library" });
    });
    wrap.appendChild(backBtn);

    const editorMount = document.createElement("div");
    wrap.appendChild(editorMount);
    root.appendChild(wrap);

    const readOnlyCompartment = new Compartment();
    const decorationsCompartment = new Compartment();
    const keymapCompartment = new Compartment();
    const selectionCompartment = new Compartment();

    const decorationField = buildDecorationField([
      headingsProducer,
      inlineProducer,
      listsProducer,
      linksProducer,
      imagesProducer,
      blockquotesProducer,
      tablesProducer,
      codeblocksProducer,
      frontmatterProducer,
      footnotesProducer,
      readingWidgetsProducer,
      mathProducer,
      mermaidProducer,
      graphvizProducer,
    ]);

    const state = EditorState.create({
      doc: route.source,
      extensions: [
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: "false" }),
        readOnlyCompartment.of(EditorState.readOnly.of(true)),
        decorationsCompartment.of(decorationField),
        keymapCompartment.of(keymap.of(defaultKeymap)),
        selectionCompartment.of([] as Extension),
      ],
    });

    const view = new EditorView({ state, parent: editorMount });
    currentView = view;

    // Bridge async cache fills to the decoration StateField (see step-1
    // notes in the cache-effect commit). One subscription per cache; we
    // unsubscribe in cleanup so subsequent document mounts don't pile up.
    const unsubHighlight = highlightCache.subscribe(() => {
      view.dispatch({ effects: highlightCacheEffect.of() });
    });
    const unsubMermaid = mermaidCache.subscribe(() => {
      view.dispatch({ effects: mermaidCacheEffect.of() });
    });
    const unsubGraphviz = graphvizCache.subscribe(() => {
      view.dispatch({ effects: graphvizCacheEffect.of() });
    });
    viewCleanups.push(unsubHighlight, unsubMermaid, unsubGraphviz);

    if (route.uriForRecents) {
      await recordRecent({
        uri: route.uriForRecents,
        displayName: uriDisplayName(route.uriForRecents),
      });
    }
  };

  window.addEventListener(LIVE_OP_EVENT, (e) => {
    const ev = e as CustomEvent<{
      pairIdHex: string;
      folderIdHex: string;
      relpath: string;
      kind: "put" | "delete";
    }>;
    const f = currentSyncedFile;
    if (
      !f ||
      f.pairIdHex !== ev.detail.pairIdHex ||
      f.folderIdHex !== ev.detail.folderIdHex ||
      f.relpath !== ev.detail.relpath
    ) {
      return;
    }
    if (ev.detail.kind === "put") {
      void (async () => {
        try {
          const source = await readSyncedFile(
            f.pairIdHex,
            f.folderIdHex,
            f.relpath,
          );
          if (currentView) {
            const { EditorSelection } = await import("@codemirror/state");
            const scrollTop = currentView.scrollDOM.scrollTop;
            currentView.dispatch({
              changes: {
                from: 0,
                to: currentView.state.doc.length,
                insert: source,
              },
              selection: EditorSelection.cursor(0),
            });
            currentView.scrollDOM.scrollTop = scrollTop;
          }
        } catch {
          void renderRoute({ kind: "library" });
          currentSyncedFile = null;
        }
      })();
    } else {
      void renderRoute({ kind: "library" });
      currentSyncedFile = null;
    }
  });

  // Android system back-button bridge (issue #96). MainActivity registers
  // an `OnBackPressedCallback` that synchronously evaluates
  // `window.__marklig_android_back()` on the webview. Returning `true`
  // means "the JS router handled it"; returning `false` lets the activity
  // background the task (i.e. exit visibly without killing the process).
  //
  // This is mobile-only — desktop builds never assign the global. Routes:
  //   document   → library  (handled — matches the always-visible back-bar)
  //   library    → exit     (unhandled)
  //   pair       → library  (handled)
  //   synced     → library  (handled)
  //
  // `navigating` guards against a double-tap of the hardware back button
  // re-entering `renderRoute` mid-transition (which destroys the EditorView
  // and re-mounts #root). While a route change is in flight we consume the
  // press (return true) without kicking off a second navigation, so a fast
  // double-tap can't double-pop or background the app mid-transition.
  let navigating = false;
  (window as unknown as {
    __marklig_android_back?: () => boolean;
  }).__marklig_android_back = (): boolean => {
    if (navigating) return true;
    const decision = decideAndroidBack(currentRoute);
    if (decision.handled) {
      navigating = true;
      void renderRoute(decision.next).finally(() => {
        navigating = false;
      });
      return true;
    }
    return false;
  };

  // Initial route: cold-launch URI > library (if non-empty) > sample.md.
  // First-launch users see the rendered sample so the app demonstrates
  // itself; once they have any history we route to the library by default.
  const initial = await getCurrentDeepLinkUrls();
  if (initial && initial.length > 0) {
    try {
      const source = await readTextFile(initial[0]);
      await renderRoute({
        kind: "document",
        source,
        uriForRecents: initial[0],
      });
    } catch (err) {
      console.error("failed to open initial deep-link", initial[0], err);
      await renderRoute({ kind: "library" });
    }
  } else {
    const [recents, pairings] = await Promise.all([
      loadRecents(),
      listMobilePairings(),
    ]);
    if (recents.length === 0 && pairings.length === 0) {
      await renderRoute({ kind: "document", source: sampleSource });
    } else {
      await renderRoute({ kind: "library" });
    }
  }

  // Warm-launch share intent: app was already running.
  await onOpenUrl(async (urls) => {
    if (urls.length === 0) return;
    try {
      const source = await readTextFile(urls[0]);
      await renderRoute({
        kind: "document",
        source,
        uriForRecents: urls[0],
      });
    } catch (err) {
      console.error("failed to open URI", urls[0], err);
    }
  });
}
