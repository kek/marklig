// Website bootstrap. Parallel to src/mobile-bootstrap.ts — same editor
// module + same decoration producers, different host environment.
//
// This file is built only by vite.config.website.ts. The Tauri-backed
// shell/store import is aliased to src/website/store-web.ts at build
// time so transitive imports via shell/settings → ui/sidebar/toc don't
// pull @tauri-apps/plugin-store into the bundle.

import type { EditorView } from "@codemirror/view";

import { createEditor, setMode } from "../editor/editor";
import type { ModeExtensions } from "../editor/editor";
import {
  buildDecorationField,
  refreshDecorationsEffect,
} from "../editor/decorations";
import { readingKeymap, editKeymap } from "../editor/keymaps";

import { headingsProducer } from "../editor/decorations/headings";
import { inlineProducer } from "../editor/decorations/inline";
import { listsProducer } from "../editor/decorations/lists";
import { linksProducer } from "../editor/decorations/links";
import { imagesProducer } from "../editor/decorations/images";
import { blockquotesProducer } from "../editor/decorations/blockquotes";
import { tablesProducer } from "../editor/decorations/tables";
import {
  codeblocksProducer,
  primeHighlighter,
} from "../editor/decorations/codeblocks";
import { frontmatterProducer } from "../editor/decorations/frontmatter";
import { footnotesProducer } from "../editor/decorations/footnotes";
import { readingWidgetsProducer } from "../editor/decorations/reading-widgets";
import { mathProducer } from "../editor/decorations/math";
import { mermaidProducer } from "../editor/decorations/mermaid";
import { graphvizProducer } from "../editor/decorations/graphviz";

export interface MountWebsiteOptions {
  root: HTMLElement;
  source: string;
}

// Reading-mode producer set — headings/links/etc. AND the reading-only
// widget producers (math, mermaid, reading-widgets). Same set the desktop
// reading mode uses.
const READING_PRODUCERS = [
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
];

// Edit-mode producer set — same producers MINUS the reading-mode widgets
// that would hide markers (readingWidgets, math, mermaid). Markers stay
// visible in edit mode so the source is editable as-typed.
const EDIT_PRODUCERS = [
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
  graphvizProducer,
];

// readingKeymap is exported as a finished `keymap.of(...)` extension;
// editKeymap is exported as a fully composed Extension[] (includes
// history() + keymap.of([...]) — see src/editor/keymaps.ts). Spread
// editKeymap directly rather than re-wrapping it.
export function buildReadingExtensions(): ModeExtensions {
  return {
    decorations: buildDecorationField(READING_PRODUCERS),
    keymap: readingKeymap,
  };
}

export function buildEditExtensions(): ModeExtensions {
  return {
    decorations: buildDecorationField(EDIT_PRODUCERS),
    keymap: [...editKeymap],
  };
}

export function mountWebsite(opts: MountWebsiteOptions): EditorView {
  document.documentElement.dataset.mode = "reading";

  const view = createEditor({ parent: opts.root, source: opts.source });

  // Install reading-mode extensions. setMode reconfigures the editor's
  // decoration / keymap / readOnly compartments in one dispatch.
  setMode(view, "reading", buildReadingExtensions());

  // Prime the syntax highlighter so code blocks render with Shiki tokens
  // on first paint. Falls back to a monospace placeholder on rejection.
  primeHighlighter(view, opts.source).catch(() => {
    /* placeholder remains */
  });

  // Nudge producers that read external state at toDOM time (e.g. the
  // eventual settings-driven image policy) to refresh on first paint.
  view.dispatch({ effects: refreshDecorationsEffect.of(undefined) });

  return view;
}
