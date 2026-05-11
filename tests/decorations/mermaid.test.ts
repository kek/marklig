import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { mermaidCache, mermaidProducer } from "../../src/editor/decorations/mermaid";
import { WidgetType } from "@codemirror/view";

function specs(source: string) {
  const tokens = parseMarkdown(source);
  const set = mermaidProducer({ source, tokens });
  const out: Array<{ from: number; to: number; spec: unknown }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({ from: cursor.from, to: cursor.to, spec: cursor.value.spec });
    cursor.next();
  }
  return out;
}

describe("mermaidProducer", () => {
  it("emits a block widget for a ```mermaid fence", () => {
    const src = "```mermaid\ngraph TD\nA-->B\n```\n";
    const r = specs(src);
    expect(r.length).toBe(1);
    expect((r[0].spec as { block?: boolean }).block).toBe(true);
    expect(r[0].from).toBe(0);
    // Replace covers fence open through close (inclusive of trailing newline).
    expect(r[0].to).toBe(src.length);
  });

  it("ignores fences without the mermaid language tag", () => {
    expect(specs("```\nplain\n```\n").length).toBe(0);
    expect(specs("```js\nx = 1\n```\n").length).toBe(0);
  });

  it("matches mermaid lang case-insensitively", () => {
    const r = specs("```Mermaid\ngraph TD\nA-->B\n```\n");
    expect(r.length).toBe(1);
  });

  it("handles multiple mermaid blocks in one document", () => {
    const src =
      "```mermaid\ngraph TD\nA-->B\n```\n\nbetween\n\n```mermaid\nflowchart LR\nx-->y\n```\n";
    const r = specs(src);
    expect(r.length).toBe(2);
  });

  it("does not match a mermaid block inside another fence's body", () => {
    // Outer fence is plain; the nested ```mermaid is just text inside it.
    const src = "```\nlooks like\n```mermaid\nfake\n```\nstill in outer\n```\n";
    const r = specs(src);
    expect(r.length).toBe(0);
  });

  it("widget eq reports inequality when cache transitions from empty to filled", () => {
    // Regression for #13: if eq returned true based on source alone, the
    // loading-state widget would be considered equal to the rendered-result
    // widget when the async render lands, and CodeMirror would reuse the
    // existing DOM — leaving "Rendering…" on screen forever.
    const src = "```mermaid\ngraph TD\nA-->B\n```\n";
    const source = "graph TD\nA-->B\n";

    // Force a clean cache state for this source.
    // (Cache is module-level; in test runs it starts empty for fresh content.)
    const loadingWidget = readWidget(src);

    // Simulate the async render landing.
    mermaidCache.set(source, { status: "ok", payload: "<svg></svg>" });

    const loadedWidget = readWidget(src);

    expect(loadingWidget.eq(loadedWidget)).toBe(false);
    expect(loadedWidget.eq(loadedWidget)).toBe(true);
  });
});

function readWidget(src: string): WidgetType {
  const tokens = parseMarkdown(src);
  const set = mermaidProducer({ source: src, tokens });
  const cursor = set.iter();
  const widget = (cursor.value!.spec as { widget: WidgetType }).widget;
  return widget;
}
