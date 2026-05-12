import { describe, it, expect } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import { readingWidgetsProducer } from "../../src/editor/decorations/reading-widgets";

function specs(source: string) {
  const tokens = parseMarkdown(source);
  const set = readingWidgetsProducer({ source, tokens });
  const out: Array<{ from: number; to: number; spec: unknown }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({ from: cursor.from, to: cursor.to, spec: cursor.value.spec });
    cursor.next();
  }
  return out;
}

describe("readingWidgetsProducer", () => {
  it("BulletWidget and SoftBreakWidget are aria-hidden in their rendered DOM", () => {
    const src = "- one\n- two\n\nFirst line\nsecond line\n";
    const tokens = parseMarkdown(src);
    const set = readingWidgetsProducer({ source: src, tokens });
    const widgets: Array<{ name: string; dom: HTMLElement }> = [];
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as {
        widget?: { constructor: { name: string }; toDOM: () => HTMLElement };
      };
      if (spec.widget) {
        widgets.push({ name: spec.widget.constructor.name, dom: spec.widget.toDOM() });
      }
      cursor.next();
    }
    const bullets = widgets.filter((w) => w.name === "BulletWidget");
    const softs = widgets.filter((w) => w.name === "SoftBreakWidget");
    expect(bullets.length).toBeGreaterThanOrEqual(2);
    expect(softs.length).toBeGreaterThanOrEqual(1);
    for (const w of bullets) expect(w.dom.getAttribute("aria-hidden")).toBe("true");
    for (const w of softs) expect(w.dom.getAttribute("aria-hidden")).toBe("true");
  });

  it("remote-image placeholder exposes role=img with aria-label including the alt text", () => {
    const src = "![A bird](https://example.com/bird.png)\n";
    const tokens = parseMarkdown(src);
    const set = readingWidgetsProducer({ source: src, tokens });
    let dom: HTMLElement | null = null;
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as {
        widget?: { constructor: { name: string }; toDOM: () => HTMLElement };
      };
      if (spec.widget?.constructor.name === "ImageWidget") {
        dom = spec.widget.toDOM();
        break;
      }
      cursor.next();
    }
    expect(dom).not.toBeNull();
    expect(dom!.getAttribute("role")).toBe("img");
    expect(dom!.getAttribute("aria-label")).toBe("Remote image: A bird");
  });

  it("hides link brackets and url, keeping inner text", () => {
    const r = specs("[t](u)\n");
    const hides = r.filter((x) => (x.spec as { class?: string }).class?.includes("cm-md-reading-elide"));
    expect(hides.length).toBeGreaterThanOrEqual(2);
  });

  it("emits an image widget for ![alt](path)", () => {
    const r = specs("![a](./p.png)\n");
    expect(r.some((x) => (x.spec as { widget?: unknown }).widget !== undefined)).toBe(true);
  });

  it("hides code fence lines but not body", () => {
    const r = specs("```\nx\n```\n");
    // Fence open + close are elided via two decorations each: an inline
    // replace (cm-md-reading-elide-fence) hiding the ``` text, and a
    // Decoration.line (cm-md-reading-elide-fence-line) collapsing the
    // line height. Together they give the code block a small vertical
    // breath without colliding with the first body line's Decoration.line.
    const elideContent = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide-fence");
    expect(elideContent.length).toBe(2);
    const lineCollapse = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide-fence-line");
    expect(lineCollapse.length).toBe(2);
  });

  it("replaces front matter with a single block widget", () => {
    const src = "---\ntitle: x\n---\n\n# Doc\n";
    const r = specs(src);
    const fmWidgets = r.filter((x) => {
      const spec = x.spec as { widget?: { constructor: { name: string } } };
      return spec.widget?.constructor.name === "FrontmatterWidget";
    });
    expect(fmWidgets.length).toBe(1);
    expect(fmWidgets[0].from).toBe(0);
    expect(fmWidgets[0].to).toBe("---\ntitle: x\n---\n".length);
  });

  it("front matter widget renders a <dl> with key/value pairs", () => {
    const src = "---\ntitle: Hi\nauthor: \"Bob\"\n---\n\n# Doc\n";
    const r = specs(src);
    const fm = r.find((x) => {
      const spec = x.spec as { widget?: { constructor: { name: string } } };
      return spec.widget?.constructor.name === "FrontmatterWidget";
    });
    type W = { widget: { toDOM: () => HTMLElement } };
    const widget = (fm!.spec as W).widget;
    const dom = widget.toDOM();
    const dts = dom.querySelectorAll("dt");
    const dds = dom.querySelectorAll("dd");
    expect(Array.from(dts).map((d) => d.textContent)).toEqual(["title", "author"]);
    expect(Array.from(dds).map((d) => d.textContent)).toEqual(["Hi", "Bob"]);
  });

  it("front matter widget falls back to raw <pre> for nested structures", () => {
    const src = "---\nlist:\n  - one\n  - two\n---\n\n# Doc\n";
    const r = specs(src);
    const fm = r.find((x) => {
      const spec = x.spec as { widget?: { constructor: { name: string } } };
      return spec.widget?.constructor.name === "FrontmatterWidget";
    });
    type W = { widget: { toDOM: () => HTMLElement } };
    const widget = (fm!.spec as W).widget;
    const dom = widget.toDOM();
    expect(dom.querySelector("dl")).toBeNull();
    expect(dom.querySelector("pre")).not.toBeNull();
  });

  it("elides heading prefix `# `", () => {
    const r = specs("# Hello\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    expect(inline.some((x) => x.from === 0 && x.to === 2)).toBe(true);
  });

  it("elides bold marker pairs but keeps inner text", () => {
    const r = specs("a **bold** b\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    expect(inline.some((x) => x.from === 2 && x.to === 4)).toBe(true);
    expect(inline.some((x) => x.from === 8 && x.to === 10)).toBe(true);
  });

  it("elides italic asterisk markers", () => {
    const r = specs("a *em* b\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    expect(inline.some((x) => x.from === 2 && x.to === 3)).toBe(true);
    expect(inline.some((x) => x.from === 5 && x.to === 6)).toBe(true);
  });

  it("elides inline code backticks", () => {
    const r = specs("a `c` b\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    expect(inline.some((x) => x.from === 2 && x.to === 3)).toBe(true);
    expect(inline.some((x) => x.from === 4 && x.to === 5)).toBe(true);
  });

  it("replaces bullet marker char with a bullet widget, keeps leading indent and trailing space", () => {
    const r = specs("- one\n  - nested\n");
    const widgets = r.filter(
      (x) => (x.spec as { widget?: unknown }).widget !== undefined,
    );
    // Top-level "- " at offset 0 → replace just the "-" at [0,1)
    expect(widgets.some((x) => x.from === 0 && x.to === 1)).toBe(true);
    // Nested "  - " at offset 6 → replace just the "-" at [8,9)
    expect(widgets.some((x) => x.from === 8 && x.to === 9)).toBe(true);
  });

  it("does not touch ordered list numbers (numbers are content)", () => {
    const r = specs("1. first\n2. second\n");
    // No ranges should overlap the "1." / "2." prefixes.
    expect(r.every((x) => !(x.from === 0 || x.from === 9))).toBe(true);
  });

  it("elides blockquote `> ` prefix", () => {
    const r = specs("> quoted\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    expect(inline.some((x) => x.from === 0 && x.to === 2)).toBe(true);
  });

  it("does not elide markers inside fenced code blocks", () => {
    const r = specs("```\n# not a heading\n**not bold**\n```\n");
    const inline = r.filter((x) => (x.spec as { class?: string }).class === "cm-md-reading-elide");
    // No inline elides should land inside the fence body (positions 4-36)
    expect(inline.every((x) => x.from < 4 || x.from >= 36)).toBe(true);
  });

  it("emits a block <hr> widget for thematic breaks", () => {
    const src = "above\n\n---\n\nbelow\n";
    const r = specs(src);
    const blockWidgets = r.filter(
      (x) =>
        (x.spec as { widget?: unknown }).widget !== undefined &&
        (x.spec as { block?: boolean }).block === true,
    );
    // The hr widget covers the line containing `---`.
    const hrFrom = src.indexOf("---");
    expect(blockWidgets.some((x) => x.from === hrFrom)).toBe(true);
  });

  it("treats `***` and `___` as thematic breaks too", () => {
    expect(
      specs("a\n\n***\n\nb\n").some(
        (x) =>
          (x.spec as { widget?: unknown }).widget !== undefined &&
          (x.spec as { block?: boolean }).block === true,
      ),
    ).toBe(true);
    expect(
      specs("a\n\n___\n\nb\n").some(
        (x) =>
          (x.spec as { widget?: unknown }).widget !== undefined &&
          (x.spec as { block?: boolean }).block === true,
      ),
    ).toBe(true);
  });

  it("emits a table widget for GFM tables", () => {
    const r = specs("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(r.some((x) => (x.spec as { widget?: unknown }).widget !== undefined && (x.spec as { block?: boolean }).block === true)).toBe(true);
  });

  it("emits softbreak replace at interior paragraph newlines", () => {
    // Paragraph reflow (#12): an interior `\n` inside a paragraph is replaced
    // with a SoftBreakWidget so CM6 visually merges the source lines.
    const src = "foo\nbar\nbaz\n";
    const r = specs(src);
    const softbreaks = r.filter((x) => {
      const w = (x.spec as { widget?: { constructor?: { name?: string } } }).widget;
      return w?.constructor?.name === "SoftBreakWidget";
    });
    expect(softbreaks).toHaveLength(2);
    expect(softbreaks[0].from).toBe(3); // \n after "foo"
    expect(softbreaks[0].to).toBe(4);
    expect(softbreaks[1].from).toBe(7); // \n after "bar"
  });

  it("does not collapse a CommonMark hard-break (two trailing spaces)", () => {
    const src = "foo  \nbar\n";
    const r = specs(src);
    const softbreaks = r.filter((x) => {
      const w = (x.spec as { widget?: { constructor?: { name?: string } } }).widget;
      return w?.constructor?.name === "SoftBreakWidget";
    });
    expect(softbreaks).toHaveLength(0);
  });

  it("does not collapse a backslash hard-break", () => {
    const src = "foo\\\nbar\n";
    const r = specs(src);
    const softbreaks = r.filter((x) => {
      const w = (x.spec as { widget?: { constructor?: { name?: string } } }).widget;
      return w?.constructor?.name === "SoftBreakWidget";
    });
    expect(softbreaks).toHaveLength(0);
  });

  it("does not insert a softbreak between separate paragraphs", () => {
    const src = "first\n\nsecond\n";
    const r = specs(src);
    const softbreaks = r.filter((x) => {
      const w = (x.spec as { widget?: { constructor?: { name?: string } } }).widget;
      return w?.constructor?.name === "SoftBreakWidget";
    });
    expect(softbreaks).toHaveLength(0);
  });

  it("table cells render basic inline markdown", () => {
    // Render the table widget's DOM and inspect the first body cell. Inline
    // **bold** must become a <strong> element, not literal asterisks.
    const r = specs("| Name | Note |\n|---|---|\n| **A** | `code` |\n");
    const tableWidget = r.find(
      (x) =>
        (x.spec as { widget?: unknown }).widget !== undefined &&
        (x.spec as { block?: boolean }).block === true,
    );
    expect(tableWidget).toBeDefined();
    const widget = (tableWidget!.spec as { widget: { toDOM(): HTMLElement } }).widget;
    const dom = widget.toDOM();
    const tds = dom.querySelectorAll("td");
    expect(tds[0].querySelector("strong")?.textContent).toBe("A");
    expect(tds[1].querySelector("code")?.textContent).toBe("code");
  });
});
