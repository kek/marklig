import { Decoration } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { createHighlighter, type Highlighter, type ThemedToken } from "shiki";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";

let highlighter: Highlighter | null = null;
const loadedLangs = new Set<string>();

export async function primeHighlighter(langs: string[] = []): Promise<void> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: ["text", ...langs],
    });
    loadedLangs.add("text");
    for (const l of langs) loadedLangs.add(l);
  } else {
    for (const lang of langs) {
      if (!loadedLangs.has(lang)) {
        await highlighter.loadLanguage(lang as never);
        loadedLangs.add(lang);
      }
    }
  }
}

export interface HighlightEntry {
  /** Per-line array of tokens; offsets within each line are derived in the producer. */
  lines: ThemedToken[][];
}

class HighlightCache {
  private map = new Map<string, HighlightEntry>();
  private inflight = new Set<string>();
  private listeners = new Set<() => void>();

  get(content: string): HighlightEntry | undefined {
    return this.map.get(content);
  }

  set(content: string, entry: HighlightEntry): void {
    this.map.set(content, entry);
    for (const l of this.listeners) l();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Idempotent compute trigger: kicks off highlighting for a fence's content
   * only if no result is cached AND no compute is already in flight for the
   * same string. Without the inflight guard, every recompute (driven by
   * highlightCacheEffect dispatches) would re-fire compute for every still-
   * pending fence, leading to quadratic blowup on docs with many code blocks. */
  request(lang: string, content: string): void {
    if (this.map.has(content) || this.inflight.has(content)) return;
    this.inflight.add(content);
    void this.compute(lang, content).then((entry) => {
      this.inflight.delete(content);
      this.set(content, entry);
    });
  }

  async compute(lang: string, content: string): Promise<HighlightEntry> {
    if (!highlighter) throw new Error("highlighter not primed");
    const safeLang = loadedLangs.has(lang) ? lang : "text";
    const result = highlighter.codeToTokens(content, {
      lang: safeLang as never,
      themes: { light: "github-light", dark: "github-dark" },
    });
    return { lines: result.tokens };
  }
}

export const highlightCache = new HighlightCache();

/** State effect dispatched when a fence's highlight result lands in the cache. */
export const highlightCacheEffect = StateEffect.define<void>();

export const codeblocksProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "fence" || !t.map) continue;
    const startLine = t.map[0];
    const endLine = t.map[1];
    const lang = (t.info || "text").trim() || "text";
    const fenceContent = t.content;

    // Line-level classes (from Plan 1). Decoration.line requires the position
    // to be exactly at a line start — shifting it (in any direction) makes
    // CM silently drop the decoration. Earlier attempts at the boundary-
    // collision-with-fence-elide problem ran into that and broke ALL body
    // line styling.
    ranges.push(
      Decoration.line({ class: "cm-md-code-fence cm-md-code-fence-open" })
        .range(lineStarts[startLine]),
    );
    for (let line = startLine + 1; line < endLine - 1; line++) {
      ranges.push(
        Decoration.line({ class: `cm-md-code-body cm-md-code-lang-${lang}` })
          .range(lineStarts[line]),
      );
    }
    if (endLine - 1 > startLine) {
      ranges.push(
        Decoration.line({ class: "cm-md-code-fence cm-md-code-fence-close" })
          .range(lineStarts[endLine - 1]),
      );
    }

    // Token-level Shiki marks: cache hit → emit; miss → fire-and-forget compute.
    const cached = highlightCache.get(fenceContent);
    if (cached) {
      const bodyStartLine = startLine + 1;
      for (let li = 0; li < cached.lines.length; li++) {
        const line = cached.lines[li];
        const lineFrom = lineStarts[bodyStartLine + li];
        if (lineFrom === undefined) break;
        let cursor = lineFrom;
        for (const tok of line) {
          const cls = colorClass(tok);
          if (cls && tok.content.length > 0) {
            ranges.push(
              Decoration.mark({ class: cls })
                .range(cursor, cursor + tok.content.length),
            );
          }
          cursor += tok.content.length;
        }
      }
    } else if (highlighter && loadedLangs.has(lang)) {
      // Idempotent: dedupes in-flight computes so repeated decoration
      // recomputes (driven by cache-fill dispatches) don't re-kick off
      // highlighting for the same content.
      highlightCache.request(lang, fenceContent);
    }
  }

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
};

function colorClass(tok: ThemedToken): string | null {
  // Single-theme mode populates tok.color; multi-theme mode populates tok.htmlStyle.
  const hex: string | undefined =
    tok.color ??
    (tok.htmlStyle as Record<string, string> | undefined)?.["color"];
  if (!hex) return null;
  const slug = hex.toLowerCase().replace(/^#/, "");
  return `cm-md-token-${slug}`;
}
