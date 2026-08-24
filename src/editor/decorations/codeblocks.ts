import { Decoration } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import {
  createHighlighter,
  bundledLanguagesInfo,
  type Highlighter,
  type ThemedToken,
} from "shiki";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";
import { tA11y } from "../../i18n/strings";

let highlighter: Highlighter | null = null;
const loadedLangs = new Set<string>();

// Alias (and canonical id) -> canonical Shiki language id, lowercased keys.
// Lets a fence tagged with a short alias (`ts`, `js`, `py`, `sh`, `c++`, …)
// resolve to the language primeHighlighter actually loaded.
const langAliases: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const info of bundledLanguagesInfo) {
    m.set(info.id.toLowerCase(), info.id);
    for (const a of info.aliases ?? []) m.set(a.toLowerCase(), info.id);
  }
  return m;
})();

/**
 * Resolve a fence language tag to the canonical Shiki language id.
 *
 * markdown-it hands us whatever the author typed after the fence (```ts,
 * ```py, ```sh). Shiki loads languages under canonical ids (typescript,
 * python, bash), and `loadedLangs` is keyed by those ids, so without this an
 * aliased fence never matches a primed language and renders with no
 * highlighting at all. Unknown tags pass through unchanged (and fall back to
 * plaintext at compute time).
 */
export function resolveLang(lang: string): string {
  return langAliases.get(lang.toLowerCase()) ?? lang;
}

export async function primeHighlighter(langs: string[] = []): Promise<void> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: ["text", ...langs],
    });
    loadedLangs.add(resolveLang("text"));
    for (const l of langs) loadedLangs.add(resolveLang(l));
  } else {
    for (const lang of langs) {
      const canon = resolveLang(lang);
      if (!loadedLangs.has(canon)) {
        await highlighter.loadLanguage(lang as never);
        loadedLangs.add(canon);
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
      Decoration.line({
        class: "cm-md-code-fence cm-md-code-fence-open",
        attributes: { "aria-hidden": "true" },
      })
        .range(lineStarts[startLine]),
    );
    for (let line = startLine + 1; line < endLine - 1; line++) {
      const isFirstBody = line === startLine + 1;
      const attributes: Record<string, string> = { role: "code" };
      if (isFirstBody) attributes["aria-label"] = tA11y("a11y.codeBlockWithLang", { lang });
      ranges.push(
        Decoration.line({
          class: `cm-md-code-body cm-md-code-lang-${lang}`,
          attributes,
        })
          .range(lineStarts[line]),
      );
    }
    if (endLine - 1 > startLine) {
      ranges.push(
        Decoration.line({
          class: "cm-md-code-fence cm-md-code-fence-close",
          attributes: { "aria-hidden": "true" },
        })
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
          const cls = colorClasses(tok);
          if (cls && tok.content.length > 0) {
            ranges.push(
              Decoration.mark({ class: cls })
                .range(cursor, cursor + tok.content.length),
            );
          }
          cursor += tok.content.length;
        }
      }
    } else if (highlighter && loadedLangs.has(resolveLang(lang))) {
      // Idempotent: dedupes in-flight computes so repeated decoration
      // recomputes (driven by cache-fill dispatches) don't re-kick off
      // highlighting for the same content. Resolve the alias so a fence
      // tagged `ts`/`js`/`py` requests the canonical loaded language.
      highlightCache.request(resolveLang(lang), fenceContent);
    }
  }

  // Indented code blocks (CommonMark 4.4). markdown-it emits these as
  // `code_block`, not `fence`: no info string, no delimiter lines, so every
  // line in the token's map is body. Handling only `fence` left this the one
  // code construct with no styling at all — the four-space block under a list
  // item, which is how prose embeds a snippet without a language tag, came
  // out as plain paragraph text. No Shiki pass: there is no language to
  // resolve, and guessing one would colour the wrong grammar.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "code_block" || !t.map) continue;
    for (let line = t.map[0]; line < t.map[1]; line++) {
      const from = lineStarts[line];
      if (from === undefined) break;
      const attributes: Record<string, string> = { role: "code" };
      if (line === t.map[0]) attributes["aria-label"] = tA11y("a11y.codeBlock");
      ranges.push(Decoration.line({ class: "cm-md-code-body", attributes }).range(from));
    }
  }

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
};

/** Slug a hex color (with or without leading #) into a CSS-class-safe suffix. */
function hexSlug(hex: string): string {
  return hex.toLowerCase().replace(/^#/, "");
}

/**
 * Token color classes for both themes.
 *
 * In multi-theme mode (`themes: { light, dark }`) Shiki populates
 * `tok.htmlStyle` with `color` (the light palette hex) and `--shiki-dark`
 * (the dark palette hex). We emit a class per palette:
 *   - `cm-md-token-<lighthex>`   styled unconditionally (the default/light)
 *   - `cm-md-tokdark-<darkhex>`  styled only under `html.theme-dark`
 * so highlighting follows the app theme via the existing theme-light/
 * theme-dark html classes. Single-theme fallback (`tok.color`) only yields
 * the light class. See styles.css for the generated palettes.
 */
function colorClasses(tok: ThemedToken): string | null {
  const style = tok.htmlStyle as Record<string, string> | undefined;
  const lightHex = tok.color ?? style?.["color"];
  const darkHex = style?.["--shiki-dark"];
  const classes: string[] = [];
  if (lightHex) classes.push(`cm-md-token-${hexSlug(lightHex)}`);
  if (darkHex) classes.push(`cm-md-tokdark-${hexSlug(darkHex)}`);
  return classes.length > 0 ? classes.join(" ") : null;
}
