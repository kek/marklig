// Reading-mode clickable-link widgets.
//
// In reading mode an inline `[text](url)` (and a bare autolink URL) is replaced
// by a real semantic `<a>` element via Decoration.replace. This is the
// accessibility win the ROADMAP "Semantic <a> for reading-mode links" note
// asked for: the link is announced as a link by screen readers and is keyboard
// activatable (Enter / Space), not just a styled run of source text.
//
// Activation model. Reading mode uses *native browser selection* (the editor's
// selectionCompartment is empty, not CM's drawSelection) — so a link competes
// with normal text selection. We resolve that the simplest way that matches a
// reading experience: a plain click / Enter / Space on the <a> *activates* the
// link (opens it externally) and we preventDefault + stopPropagation so neither
// the browser's own navigation nor CodeMirror's position-based click handler
// also fires. Selecting text by dragging across the link still works through
// native selection because the <a> is an ordinary inline element. We do not
// implement modifier-click passthrough — plain activation is the default and is
// what a reader expects.
//
// Scheme safety. Only `http:` and `https:` links become widgets here, and the
// activation path re-checks the scheme before calling the opener, so a
// `javascript:` / `file:` / `data:` URL can never be opened externally. Other
// schemes (local `.md`, `#anchor`, `mailto:`) are intentionally left to the
// reading-mode text elision (reading-widgets.ts) plus the position-based
// linkClickExtension, which already classifies and routes them.

import { Decoration, WidgetType } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import type Token from "markdown-it/lib/token.mjs";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";
import { t } from "../../i18n/strings";

/** True only for `http:` / `https:` URLs. Pure, case-insensitive. Everything
 *  else — `javascript:`, `file:`, `data:`, `mailto:`, relative paths, anchors,
 *  the empty string — is rejected so it can never reach the external opener. */
export function isExternalLinkScheme(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

/** Opener seam. Defaults to the Tauri opener plugin (lazy dynamic import so the
 *  module stays importable in plain-browser / jsdom test contexts). Tests can
 *  inject a synchronous spy via setLinkOpener. */
type LinkOpener = (url: string) => void | Promise<void>;

let injectedOpener: LinkOpener | null = null;

/** Inject an opener (for tests). Pass null to restore the default. */
export function setLinkOpener(opener: LinkOpener | null): void {
  injectedOpener = opener;
}

function openExternally(url: string): void {
  if (!isExternalLinkScheme(url)) return;
  if (injectedOpener) {
    void injectedOpener(url);
    return;
  }
  void import("@tauri-apps/plugin-opener")
    .then(({ openUrl }) => openUrl(url))
    .catch((err) => {
      // A broken URL shouldn't trap the reader — surface non-modally.
      console.warn("openUrl failed", err);
    });
}

export class LinkWidget extends WidgetType {
  constructor(readonly href: string, readonly text: string) {
    super();
  }

  override toDOM(): HTMLElement {
    const a = document.createElement("a");
    a.className = "cm-md-reading-link";
    a.href = this.href;
    // textContent (never innerHTML) — the link text is untrusted source.
    a.textContent = this.text;
    a.setAttribute("aria-label", t("a11y.link"));
    // Reachable by keyboard. A bare <a href> is already focusable, but the
    // widget lives inside CM's contenteditable; tabindex keeps it in the tab
    // order reliably across webviews.
    a.tabIndex = 0;

    const activate = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      openExternally(this.href);
    };
    a.addEventListener("click", activate);
    a.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") activate(e);
    });
    // CM treats mousedown inside content as the start of a selection / caret
    // placement; swallow it on the anchor so a plain click reads as activation.
    a.addEventListener("mousedown", (e) => e.stopPropagation());
    return a;
  }

  override eq(other: LinkWidget): boolean {
    return other.href === this.href && other.text === this.text;
  }

  override ignoreEvent(): boolean {
    // Let the widget's own DOM listeners handle events instead of CM.
    return true;
  }
}

export const readingLinkWidgetsProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "inline" || !t.children || !t.map) continue;
    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    const blockSource = source.slice(blockStart, blockEnd);
    walk(t.children, blockStart, blockSource, ranges);
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
};

function walk(
  children: Token[],
  lineStart: number,
  lineSource: string,
  out: Range<Decoration>[],
): void {
  let cursor = 0;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.type === "link_open") {
      const href = c.attrGet("href") ?? "";
      const nextText = children[i + 1];
      const isAutolink =
        c.markup === "" &&
        nextText?.type === "text" &&
        nextText.content === href;

      if (isAutolink) {
        const idx = lineSource.indexOf(nextText.content, cursor);
        if (idx < 0) continue;
        if (isExternalLinkScheme(href)) {
          out.push(
            Decoration.replace({ widget: new LinkWidget(href, nextText.content) }).range(
              lineStart + idx,
              lineStart + idx + nextText.content.length,
            ),
          );
        }
        cursor = idx + nextText.content.length;
      } else {
        // Inline link: [text](url)
        const text = collectTextUntilClose(children, i + 1);
        const literal = "[" + text + "]";
        const textIdx = lineSource.indexOf(literal, cursor);
        if (textIdx < 0) continue;
        const urlStart = lineSource.indexOf("(", textIdx + literal.length);
        if (urlStart < 0) continue;
        const urlEnd = lineSource.indexOf(")", urlStart);
        if (urlEnd < 0) continue;
        const constructEnd = urlEnd + 1;
        if (isExternalLinkScheme(href)) {
          out.push(
            Decoration.replace({ widget: new LinkWidget(href, text) }).range(
              lineStart + textIdx,
              lineStart + constructEnd,
            ),
          );
        }
        cursor = constructEnd;
      }
    } else if (c.type === "text" && /^https?:\/\/\S+/.test(c.content)) {
      // Fallback: plain-text URL when linkify is disabled.
      const idx = lineSource.indexOf(c.content, cursor);
      if (idx >= 0) {
        out.push(
          Decoration.replace({ widget: new LinkWidget(c.content, c.content) }).range(
            lineStart + idx,
            lineStart + idx + c.content.length,
          ),
        );
        cursor = idx + c.content.length;
      }
    } else if (c.type === "text") {
      const idx = lineSource.indexOf(c.content, cursor);
      if (idx >= 0) cursor = idx + c.content.length;
    }
  }
}

function collectTextUntilClose(children: Token[], start: number): string {
  let out = "";
  for (let i = start; i < children.length; i++) {
    if (children[i].type === "link_close") break;
    if (children[i].type === "text") out += children[i].content;
  }
  return out;
}
