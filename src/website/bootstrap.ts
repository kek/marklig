// Website bootstrap. Parallel to src/mobile-bootstrap.ts — same editor
// module + same decoration producers, different host environment.
//
// This file is built only by vite.config.website.ts. The Tauri-backed
// shell/store import is aliased to src/website/store-web.ts at build
// time so transitive imports via shell/settings → ui/sidebar/toc don't
// pull @tauri-apps/plugin-store into the bundle.

import type { EditorView } from "@codemirror/view";

import { createEditor } from "../editor/editor";

export interface MountWebsiteOptions {
  root: HTMLElement;
  source: string;
}

export function mountWebsite(opts: MountWebsiteOptions): EditorView {
  document.documentElement.dataset.mode = "reading";
  return createEditor({ parent: opts.root, source: opts.source });
}
