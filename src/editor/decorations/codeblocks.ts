import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { createHighlighter, type Highlighter } from "shiki";

import type { DecorationProducer } from "./index";

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

export const codeblocksProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "fence" || !t.map) continue;
    const startLine = t.map[0];
    const endLine = t.map[1];
    const lang = (t.info || "text").trim() || "text";

    // Open fence (the line with ```lang)
    ranges.push(
      Decoration.line({ class: "cm-md-code-fence cm-md-code-fence-open" })
        .range(lineStarts[startLine]),
    );
    // Body lines (between open and close fence)
    for (let line = startLine + 1; line < endLine - 1; line++) {
      ranges.push(
        Decoration.line({ class: `cm-md-code-body cm-md-code-lang-${lang}` })
          .range(lineStarts[line]),
      );
    }
    // Close fence
    if (endLine - 1 > startLine) {
      ranges.push(
        Decoration.line({ class: "cm-md-code-fence cm-md-code-fence-close" })
          .range(lineStarts[endLine - 1]),
      );
    }
  }

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
};

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
