import { describe, it, expect } from "vitest";
import { WidgetType } from "@codemirror/view";

import { parseMarkdown } from "../../src/editor/parser";
import { graphvizCache, graphvizProducer } from "../../src/editor/decorations/graphviz";

function specs(source: string) {
  const tokens = parseMarkdown(source);
  const set = graphvizProducer({ source, tokens });
  const out: Array<{ from: number; to: number; spec: unknown }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({ from: cursor.from, to: cursor.to, spec: cursor.value.spec });
    cursor.next();
  }
  return out;
}

describe("graphvizProducer", () => {
  it("emits a block widget for a ```dot fence", () => {
    const src = "```dot\ndigraph { a -> b }\n```\n";
    const r = specs(src);
    expect(r.length).toBe(1);
    expect((r[0].spec as { block?: boolean }).block).toBe(true);
    expect(r[0].from).toBe(0);
    expect(r[0].to).toBe(src.length);
  });

  it("also matches the ```graphviz lang tag", () => {
    const src = "```graphviz\ndigraph { a -> b }\n```\n";
    const r = specs(src);
    expect(r.length).toBe(1);
  });

  it("matches lang case-insensitively", () => {
    const r = specs("```DOT\ndigraph { a -> b }\n```\n");
    expect(r.length).toBe(1);
  });

  it("ignores fences without a graphviz language tag", () => {
    expect(specs("```\nplain\n```\n").length).toBe(0);
    expect(specs("```js\nx = 1\n```\n").length).toBe(0);
    expect(specs("```mermaid\ngraph TD\nA-->B\n```\n").length).toBe(0);
  });

  it("handles multiple graphviz blocks in one document", () => {
    const src =
      "```dot\ndigraph { a -> b }\n```\n\nbetween\n\n```graphviz\ngraph { x -- y }\n```\n";
    const r = specs(src);
    expect(r.length).toBe(2);
  });

  it("widget eq reports inequality when cache transitions from empty to filled", () => {
    // Regression-safety equivalent of the Mermaid #13 fix: a loading widget
    // must not compare equal to a loaded widget, otherwise CM6 keeps the
    // "Rendering…" DOM after the async render lands.
    const src = "```dot\ndigraph foo { a -> b }\n```\n";
    const source = "digraph foo { a -> b }\n";

    const loadingWidget = readWidget(src);
    graphvizCache.set(source, { status: "ok", payload: "<svg></svg>" });
    const loadedWidget = readWidget(src);

    expect(loadingWidget.eq(loadedWidget)).toBe(false);
    expect(loadedWidget.eq(loadedWidget)).toBe(true);
  });

  it("widget DOM exposes ARIA: loading announces via role=status; cached success uses role=img + aria-label", () => {
    const src = "```dot\ndigraph { A -> B }\n```\n";
    const tokens = parseMarkdown(src);
    const set = graphvizProducer({ source: src, tokens });
    let widget: WidgetType | undefined;
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as { widget?: WidgetType };
      if (spec.widget) { widget = spec.widget; break; }
      cursor.next();
    }
    expect(widget).toBeTruthy();

    const loading = widget!.toDOM();
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.getAttribute("aria-live")).toBe("polite");
    expect(loading.getAttribute("aria-label")).toBe("Rendering Graphviz diagram");

    const sourceText = "digraph { A -> B }\n";
    graphvizCache.set(sourceText, { status: "ok", payload: "<svg></svg>" });
    const set2 = graphvizProducer({ source: src, tokens });
    let widget2: WidgetType | undefined;
    const cursor2 = set2.iter();
    while (cursor2.value) {
      const spec = cursor2.value.spec as { widget?: WidgetType };
      if (spec.widget) { widget2 = spec.widget; break; }
      cursor2.next();
    }
    const okDom = widget2!.toDOM();
    expect(okDom.getAttribute("role")).toBe("img");
    expect(okDom.getAttribute("aria-label")).toBe("Graphviz diagram");
  });
});

function readWidget(src: string): WidgetType {
  const tokens = parseMarkdown(src);
  const set = graphvizProducer({ source: src, tokens });
  const cursor = set.iter();
  const widget = (cursor.value!.spec as { widget: WidgetType }).widget;
  return widget;
}
