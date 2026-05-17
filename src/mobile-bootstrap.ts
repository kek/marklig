// Mobile (Android) bootstrap. Step 1 of the v2 mobile companion: there is
// no file shell, no library, no sync — the renderer runs against a single
// bundled `sample.md` to prove the existing decoration pipeline ports to
// Android WebView.
//
// Everything desktop-specific (recents, recovery, watcher, native menus,
// folder palette, multi-window session restore) is intentionally absent.
// Step 2 adds the SAF file shell; step 3 adds the library UI.

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

import sampleSource from "./sample.md?raw";
import "katex/dist/katex.min.css";

export async function mobileBootstrap(): Promise<void> {
  applyTheme(loadStoredTheme());
  watchSystemTheme(() => applyTheme(loadStoredTheme()));
  await loadSettings();

  // Prime Shiki for the languages that appear in sample.md. The async
  // highlight cache fills in afterward and dispatches highlightCacheEffect;
  // our decoration StateField listens for it (see effects list below).
  await primeHighlighter(["rust"]);

  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  root.innerHTML = "";

  // Reading-mode decoration set — same producer composition as desktop
  // reading mode, minus folder/sidebar-driven extras that don't apply
  // until a library UI lands in step 3.
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

  const readOnlyCompartment = new Compartment();
  const decorationsCompartment = new Compartment();
  const keymapCompartment = new Compartment();
  const selectionCompartment = new Compartment();

  const state = EditorState.create({
    doc: sampleSource,
    extensions: [
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ spellcheck: "false" }),
      readOnlyCompartment.of(EditorState.readOnly.of(true)),
      decorationsCompartment.of(decorationField),
      keymapCompartment.of(keymap.of(defaultKeymap)),
      // Reading-mode uses native browser selection — drawSelection() paints
      // blocky rectangles over widget-heavy layout. Same call as desktop.
      selectionCompartment.of([] as Extension),
    ],
  });

  const view = new EditorView({ state, parent: root });

  // Bridge async cache fills to the decoration StateField. Without these
  // subscriptions the highlight / mermaid / graphviz producers return their
  // synchronous placeholder on first compute, the async work eventually
  // populates the cache, and… nothing dispatches an effect to make the
  // StateField recompute. Symptoms on Android WebView (smoke run, 2026-05-17):
  // code fences stayed unstyled, Mermaid stuck on "Rendering diagram…".
  // Desktop wires these in src/main.ts at bootstrap; mobile needs its own copy.
  highlightCache.subscribe(() => {
    view.dispatch({ effects: highlightCacheEffect.of() });
  });
  mermaidCache.subscribe(() => {
    view.dispatch({ effects: mermaidCacheEffect.of() });
  });
  graphvizCache.subscribe(() => {
    view.dispatch({ effects: graphvizCacheEffect.of() });
  });
}
