// Website bootstrap. Parallel to src/mobile-bootstrap.ts — same editor
// module + same decoration producers, different host environment.
//
// This file is built only by vite.config.website.ts. The Tauri-backed
// shell/store import is aliased to src/website/store-web.ts at build
// time so transitive imports via shell/settings → ui/sidebar/toc don't
// pull @tauri-apps/plugin-store into the bundle.

import { EditorView } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";

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
import { linkClickExtension, buildAnchorIndex } from "../editor/link-clicks";
import type { LinkClickHandlers } from "../editor/link-clicks";
import { mountToolbar, computeDocStats } from "../ui/toolbar";
import { mountTocSidebar } from "../ui/sidebar/toc";
import type { TocSidebarHandle, TocEntry } from "../ui/sidebar/toc";

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

  const readingExt = buildReadingExtensions();
  const editExt = buildEditExtensions();

  setMode(view, "reading", readingExt);

  // LinkClickHandlers (from src/editor/link-clicks.ts) has four fields.
  // The website only meaningfully serves external links and same-doc
  // anchor jumps; the other two are no-ops because content.md is the
  // only document and there are no local-markdown files to open.
  const linkHandlers: LinkClickHandlers = {
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openLocalMarkdown: async () => {
      /* no-op: no local .md files reachable from the website */
    },
    scrollToAnchor: (slug) => {
      const index = buildAnchorIndex(view.state.doc.toString());
      const line = index.get(slug);
      if (line == null) return false;
      const pos = view.state.doc.line(line).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start" }),
      });
      return true;
    },
    resolveRelativeMarkdown: async () => null,
  };
  view.dispatch({
    effects: StateEffect.appendConfig.of(linkClickExtension(linkHandlers)),
  });

  // TOC sidebar — mounted lazily on first toggle click. mountTocSidebar
  // appends a <aside class="viewer-toc"> to its parent.
  let tocHandle: TocSidebarHandle | null = null;
  // Forward-declared so onSidebarToggle can call toolbar.setSidebarVisible.
  // The closure resolves at click time, after mountToolbar returns.
  // eslint-disable-next-line prefer-const
  let toolbar: ReturnType<typeof mountToolbar>;

  const onSidebarToggle = (): void => {
    if (!tocHandle) {
      tocHandle = mountTocSidebar({
        view,
        parent: opts.root,
        initiallyVisible: true,
        initialDocumentPath: "content.md",
        onActivate: (entry: TocEntry) => {
          view.dispatch({
            selection: { anchor: entry.from },
            effects: EditorView.scrollIntoView(entry.from, { y: "start" }),
          });
        },
      });
      toolbar.setSidebarVisible(true);
    } else {
      const next = !tocHandle.isVisible();
      tocHandle.setVisible(next);
      toolbar.setSidebarVisible(next);
    }
  };

  toolbar = mountToolbar(opts.root, {
    view,
    modeExtensions: { reading: readingExt, edit: editExt },
    initialMode: "reading",
    onModeChange: (mode) => {
      document.documentElement.dataset.mode = mode;
    },
    onSidebarToggle,
    initialSidebarVisible: false,
  });

  toolbar.setDirty(false);
  toolbar.setPath("content.md");
  toolbar.setStats(computeDocStats(opts.source));
  toolbar.setStatus(null);

  primeHighlighter(view, opts.source).catch(() => {
    /* placeholder remains */
  });

  view.dispatch({ effects: refreshDecorationsEffect.of(undefined) });

  return view;
}

// ----- auto-mount (browser only) -----
//
// Vite's ?raw query loads the file contents as a string at build time.
// The path is relative to this file; ../../website/content.md resolves
// to website/content.md at the repo root.
//
// Skipped under vitest (env.VITEST="true" in vitest.config.ts) so unit
// tests that create their own #root don't trip on a second auto-mount.
import contentMd from "../../website/content.md?raw";

if (
  typeof document !== "undefined" &&
  !(import.meta as any).env?.VITEST
) {
  const root = document.getElementById("root");
  if (root) {
    mountWebsite({ root, source: contentMd });
  }
}
