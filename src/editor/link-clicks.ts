// Reading-mode link click handler.
//
// CodeMirror gives us a `click` DOM event whose target lands somewhere inside
// a decorated link span (.cm-md-link-text / .cm-md-link-url / .cm-md-link-auto).
// Instead of trying to walk DOM ancestors back to a stored href, we resolve the
// link by *position*: take `view.posAtDOM(event.target)`, then look up which
// markdown-it link token brackets that offset in the parsed source. This is the
// same token stream the decoration producers run against, so it's exactly the
// data already known to the renderer — no second source of truth.
//
// External (http/https/mailto) → @tauri-apps/plugin-opener
// Local relative .md → existing in-app open path (drag-drop / file-association
//                     pipeline; preserves watcher, recents, per-file scroll).
// In-doc anchor (#foo) → scroll to the matching heading inside this document.
// Anything else → opener plugin as a generic URL.
//
// Edit mode keeps its native cursor-on-click — this handler gates on
// `view.state.readOnly` and bails when the editor isn't in reading mode.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { parseMarkdown } from "./parser";
import { computeLineStarts } from "./decorations";
import { findInlineLinkSpan } from "./decorations/links";
import { extractTocEntries } from "../ui/sidebar/toc";

export interface ResolvedLink {
  /** Raw href as it appears in the source (decoded). */
  href: string;
  /** Inclusive source range of the entire link construct (e.g. `[text](url)`
   *  for inline links, or the URL itself for autolinks). Useful for tests. */
  from: number;
  to: number;
}

/** Find the link that brackets `pos` in `source`, or null if none.
 *
 *  The walk mirrors `linksProducer` but doesn't have to emit decorations — it
 *  just needs the offsets and the href. Both inline `[text](url)` and
 *  autolinks (linkify-generated, where `markup === ""`) are recognised. */
export function resolveLinkAt(source: string, pos: number): ResolvedLink | null {
  if (source.length === 0) return null;
  const tokens = parseMarkdown(source);
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "inline" || !t.children || !t.map) continue;
    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    if (pos < blockStart || pos > blockEnd) continue;
    const blockSource = source.slice(blockStart, blockEnd);

    const children = t.children;
    let cursor = 0;
    for (let j = 0; j < children.length; j++) {
      const c = children[j];
      if (c.type === "link_open") {
        const href = c.attrGet("href") ?? "";
        const next = children[j + 1];
        const isAutolink =
          c.markup === "" &&
          next?.type === "text" &&
          next.content === href;
        if (isAutolink) {
          const idx = blockSource.indexOf(next.content, cursor);
          if (idx < 0) continue;
          const from = blockStart + idx;
          const to = from + next.content.length;
          if (pos >= from && pos <= to) {
            return { href, from, to };
          }
          cursor = idx + next.content.length;
        } else {
          // Inline link: [text](url). Locate the span by scanning the real
          // source structure — reconstructing `[text]` from the child text
          // tokens drops nested inline markup (em/strong/code/strikethrough)
          // so the click would silently fail to resolve. See issue #156.
          const span = findInlineLinkSpan(blockSource, cursor);
          if (!span) continue;
          const from = blockStart + span.from;
          const to = blockStart + span.to;
          if (pos >= from && pos <= to) {
            return { href, from, to };
          }
          cursor = span.to;
        }
      } else if (
        c.type === "text" &&
        /^https?:\/\/\S+/.test(c.content)
      ) {
        const idx = blockSource.indexOf(c.content, cursor);
        if (idx < 0) continue;
        const from = blockStart + idx;
        const to = from + c.content.length;
        if (pos >= from && pos <= to) {
          return { href: c.content, from, to };
        }
        cursor = idx + c.content.length;
      } else if (c.type === "text") {
        const idx = blockSource.indexOf(c.content, cursor);
        if (idx >= 0) cursor = idx + c.content.length;
      }
    }
  }
  return null;
}

/** GitHub-style heading slugifier — what the eventual HTML export and most
 *  shared anchor links assume. Lowercase, strip non-alphanumeric (except
 *  spaces and dashes), collapse whitespace to dashes. We don't try to match
 *  every edge case markdown-it-anchor handles, just the common ones. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export type LinkKind =
  | { kind: "external"; url: string }
  | { kind: "local-md"; rawPath: string }
  | { kind: "anchor"; slug: string }
  | { kind: "other"; url: string };

const MD_EXT_RE = /\.(md|markdown|mdx|mdown)(?:#[^?]*)?(?:\?[^#]*)?$/i;
const EXTERNAL_SCHEME_RE = /^(https?|mailto|tel|ftp|ftps):/i;

/** Classify an href into one of the kinds the click handler can dispatch on.
 *  Pure — no side effects, no I/O. */
export function classifyLink(href: string): LinkKind {
  const trimmed = href.trim();
  if (trimmed.length === 0) return { kind: "other", url: href };
  if (trimmed.startsWith("#")) {
    return { kind: "anchor", slug: trimmed.slice(1) };
  }
  if (EXTERNAL_SCHEME_RE.test(trimmed)) {
    return { kind: "external", url: trimmed };
  }
  // Other custom schemes (file:, vscode:, custom:) — defer to OS opener.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return { kind: "other", url: trimmed };
  }
  if (MD_EXT_RE.test(trimmed)) {
    return { kind: "local-md", rawPath: trimmed };
  }
  return { kind: "other", url: trimmed };
}

export interface LinkClickHandlers {
  /** Open an external URL via the OS — http/https/mailto, custom schemes. */
  openExternal: (url: string) => void | Promise<void>;
  /** Open a markdown file by absolute path in this window. */
  openLocalMarkdown: (absPath: string) => void | Promise<void>;
  /** Scroll to a heading by slug; returns true if the slug was found. */
  scrollToAnchor: (slug: string) => boolean;
  /** Resolve a `./relative.md` style href against the currently-open file.
   *  Returns null when no file is open (so the link can't be resolved). */
  resolveRelativeMarkdown: (rawPath: string) => Promise<string | null>;
}

/** Install the reading-mode click handler. Gated on `view.state.readOnly`
 *  so edit mode keeps its native cursor-placement behavior. */
export function linkClickExtension(handlers: LinkClickHandlers): Extension {
  return EditorView.domEventHandlers({
    click(event, view) {
      if (!view.state.readOnly) return false;
      if (event.button !== 0) return false;
      if (event.defaultPrevented) return false;
      // Cmd/Ctrl-click would normally let CM place a secondary cursor — we
      // still want link behavior in reading mode (there's no cursor there
      // anyway), so don't gate on modifiers. Shift-click is also fine.
      const target = event.target as Node | null;
      if (!target) return false;
      let pos: number | null;
      try {
        pos = view.posAtDOM(target);
      } catch {
        return false;
      }
      if (pos == null) return false;

      const source = view.state.doc.toString();
      const resolved = resolveLinkAt(source, pos);
      if (!resolved) return false;

      event.preventDefault();
      event.stopPropagation();
      void dispatchClick(resolved.href, handlers);
      return true;
    },
  });
}

async function dispatchClick(
  href: string,
  handlers: LinkClickHandlers,
): Promise<void> {
  const kind = classifyLink(href);
  switch (kind.kind) {
    case "external":
      await handlers.openExternal(kind.url);
      return;
    case "anchor": {
      const ok = handlers.scrollToAnchor(kind.slug);
      // Fall through to opener only if we have a "real" URL — a bare "#foo"
      // that doesn't match any heading is just a dead link, not something to
      // hand off to the OS.
      if (!ok) {
        // No-op: a missing anchor in the current document shouldn't navigate.
      }
      return;
    }
    case "local-md": {
      const abs = await handlers.resolveRelativeMarkdown(kind.rawPath);
      if (abs) await handlers.openLocalMarkdown(abs);
      else await handlers.openExternal(kind.rawPath);
      return;
    }
    case "other":
      await handlers.openExternal(kind.url);
      return;
  }
}

/** Build a slug → source-offset map from the current document. Strips a
 *  `#fragment` and `?query` from the slug input before lookup, mirroring
 *  what `classifyLink` extracts. Heading order matters for duplicate slugs
 *  — first heading wins, same as GitHub. */
export function buildAnchorIndex(source: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of extractTocEntries(source)) {
    const slug = slugifyHeading(entry.text);
    if (slug.length === 0) continue;
    if (!out.has(slug)) out.set(slug, entry.from);
  }
  return out;
}
