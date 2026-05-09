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

  it("marks EVERY body line of a multi-line fence", () => {
    const src = "```typescript\n    const a = 1;\n    const b = 2;\n    const c = 3;\n    const d = 4;\n```\n";
    const r = classes(src);
    const bodyDecs = r.filter((x) => x.class.includes("cm-md-code-body"));
    expect(bodyDecs.length).toBe(4);
    // Decoration.line requires the position to be exactly at the line start;
    // any shift (even +1) is invalid and CM silently drops the decoration.
    const lineStarts: number[] = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
    expect(bodyDecs.map((d) => d.from).sort((a, b) => a - b)).toEqual([
      lineStarts[1],
      lineStarts[2],
      lineStarts[3],
      lineStarts[4],
    ]);
  });

  it("first body line decoration position doesn't collide with any reading-mode fence elide", async () => {
    // Combined codeblocks + reading-widgets producers (the reading-mode
    // pipeline). Earlier the fence-elide was a block-replace covering
    // [openLineStart, firstBodyLineStart) — its `to` collided with the
    // first body line's Decoration.line at firstBodyLineStart, and CM
    // silently dropped the line dec (manifest: first body line rendered
    // in serif without the cm-md-code-body class). Pin the new invariant:
    // NO reading-widgets decoration touches firstBodyLineStart, while
    // the body-line dec at firstBodyLineStart is still emitted.
    const { readingWidgetsProducer } = await import("../../src/editor/decorations/reading-widgets");
    const src = "```typescript\n    const a = 1;\n    const b = 2;\n```\n";
    const tokens = parseMarkdown(src);
    const cb = codeblocksProducer({ source: src, tokens });
    const rw = readingWidgetsProducer({ source: src, tokens });

    const lineStarts: number[] = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
    const firstBodyLineStart = lineStarts[1];

    // Codeblocks producer still emits a Decoration.line at the first body
    // line's start — Decoration.line positions MUST be at exact line
    // starts; CM silently drops them otherwise.
    const cbCursor = cb.iter();
    let foundFirstBodyDec = false;
    while (cbCursor.value) {
      const cls = (cbCursor.value.spec as { class?: string }).class ?? "";
      if (cbCursor.from === firstBodyLineStart && cls.includes("cm-md-code-body")) {
        foundFirstBodyDec = true;
        break;
      }
      cbCursor.next();
    }
    expect(foundFirstBodyDec).toBe(true);

    // Reading-widgets must NOT have any decoration whose `to` equals
    // firstBodyLineStart — that's the regression that ate the body line dec.
    const rwCursor = rw.iter();
    while (rwCursor.value) {
      expect(rwCursor.to).not.toBe(firstBodyLineStart);
      rwCursor.next();
    }
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
