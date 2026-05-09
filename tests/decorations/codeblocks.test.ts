import { describe, it, expect, beforeAll } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { codeblocksProducer, primeHighlighter, highlightCache } from "../../src/editor/decorations/codeblocks";

beforeAll(async () => {
  await primeHighlighter(["javascript"]);
});

function classes(source: string) {
  const tokens = parseMarkdown(source);
  const set = codeblocksProducer({ source, tokens });
  const out: Array<{ from: number; to: number; class: string }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({
      from: cursor.from,
      to: cursor.to,
      class: (cursor.value.spec as { class?: string }).class ?? "",
    });
    cursor.next();
  }
  return out;
}

describe("codeblocksProducer", () => {
  it("marks fence lines with cm-md-code-fence", () => {
    const src = "```js\nconst x = 1;\n```\n";
    const r = classes(src);
    const fences = r.filter((x) => x.class.includes("cm-md-code-fence"));
    expect(fences.length).toBeGreaterThanOrEqual(2);
  });

  it("marks code body lines with cm-md-code-body", () => {
    const src = "```js\nconst x = 1;\n```\n";
    const r = classes(src);
    expect(r.some((x) => x.class.includes("cm-md-code-body"))).toBe(true);
  });

  it("marks EVERY body line of a multi-line fence (regression: first body line was being skipped at render time)", () => {
    const src = "```typescript\n    const a = 1;\n    const b = 2;\n    const c = 3;\n    const d = 4;\n```\n";
    const r = classes(src);
    const bodyDecs = r.filter((x) => x.class.includes("cm-md-code-body"));
    // Expect 4 body line decorations — one per body line.
    expect(bodyDecs.length).toBe(4);
    // The body line dec's `from` is shifted by +1 from the line start to
    // dodge the boundary collision with the fence-open block-replace's `to`
    // (which equals the line start). CM's Decoration.line still targets the
    // containing line.
    const lineStarts: number[] = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
    expect(bodyDecs.map((d) => d.from).sort((a, b) => a - b)).toEqual([
      lineStarts[1] + 1,
      lineStarts[2] + 1,
      lineStarts[3] + 1,
      lineStarts[4] + 1,
    ]);
  });

  it("first body line decoration position doesn't collide with the fence-elide block-replace", async () => {
    // Combined codeblocks + reading-widgets producers (the reading-mode
    // pipeline). The fence-elide replace covers [openLineStart, firstBodyLineStart).
    // The body line decoration on the first body line is at firstBodyLineStart
    // exactly — same position as the elide's `to`. CM uses startSide / endSide
    // to disambiguate, but if our positional sort doesn't preserve that, the
    // line decoration can be lost (manifests in the rendered DOM as the first
    // body line missing cm-md-code-body class).
    const { readingWidgetsProducer } = await import("../../src/editor/decorations/reading-widgets");
    const src = "```typescript\n    const a = 1;\n    const b = 2;\n```\n";
    const tokens = parseMarkdown(src);
    const cb = codeblocksProducer({ source: src, tokens });
    const rw = readingWidgetsProducer({ source: src, tokens });

    // First body line position
    const lineStarts: number[] = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
    const firstBodyLineStart = lineStarts[1];

    // Codeblocks producer should have a body-line decoration whose position
    // is on the first body line (one char in, to dodge the boundary
    // collision with the fence-open elide's `to`).
    const cbCursor = cb.iter();
    let foundFirstBodyDec = false;
    while (cbCursor.value) {
      const cls = (cbCursor.value.spec as { class?: string }).class ?? "";
      if (cbCursor.from === firstBodyLineStart + 1 && cls.includes("cm-md-code-body")) {
        foundFirstBodyDec = true;
        break;
      }
      cbCursor.next();
    }
    expect(foundFirstBodyDec).toBe(true);

    // Reading-widgets producer should have a fence-elide block-replace whose
    // `to` equals firstBodyLineStart.
    const rwCursor = rw.iter();
    let foundElide = false;
    while (rwCursor.value) {
      const cls = (rwCursor.value.spec as { class?: string }).class ?? "";
      if (cls.includes("cm-md-reading-elide-fence") && rwCursor.to === firstBodyLineStart) {
        foundElide = true;
        break;
      }
      rwCursor.next();
    }
    expect(foundElide).toBe(true);
  });
});

it("emits token-color marks once a fence has been highlighted", async () => {
  const src = "```js\nconst x = 1;\n```\n";
  const tokens = parseMarkdown(src);
  const fence = tokens.find((t) => t.type === "fence");
  if (!fence || !fence.map) throw new Error("no fence");
  await primeHighlighter(["javascript"]);
  const entry = await highlightCache.compute("javascript", fence.content);
  highlightCache.set(fence.content, entry);

  const set = codeblocksProducer({ source: src, tokens });
  const out: Array<{ from: number; to: number; class: string }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({
      from: cursor.from,
      to: cursor.to,
      class: (cursor.value.spec as { class?: string }).class ?? "",
    });
    cursor.next();
  }

  const tokenMarks = out.filter((x) => x.class.startsWith("cm-md-token-"));
  expect(tokenMarks.length).toBeGreaterThan(0);
});
