import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { parseMarkdown } from "../../src/editor/parser";
import { buildDecorationField } from "../../src/editor/decorations";
import { markdownFormat } from "../../src/format/markdown";
import {
  CALLOUT_KINDS,
  calloutLabel,
  calloutsProducer,
  scanCallouts,
} from "../../src/editor/decorations/callouts";
import { blockquotesProducer } from "../../src/editor/decorations/blockquotes";
import { readingWidgetsProducer } from "../../src/editor/decorations/reading-widgets";

function scan(source: string) {
  return scanCallouts(source, parseMarkdown(source));
}

interface Emitted {
  from: number;
  to: number;
  class?: string;
  attributes?: Record<string, string>;
}

function emitted(source: string): Emitted[] {
  const tokens = parseMarkdown(source);
  const set = calloutsProducer({ source, tokens });
  const out: Emitted[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    const spec = cursor.value.spec as {
      class?: string;
      attributes?: Record<string, string>;
    };
    out.push({
      from: cursor.from,
      to: cursor.to,
      class: spec.class,
      attributes: spec.attributes,
    });
    cursor.next();
  }
  return out;
}

/** Line decorations are zero-length (from === to); marks cover a real span. */
const lineDecs = (all: Emitted[]) => all.filter((d) => d.from === d.to);
const markDecs = (all: Emitted[]) => all.filter((d) => d.from !== d.to);

describe("scanCallouts", () => {
  it("recognises all five GitHub alert kinds", () => {
    for (const kind of CALLOUT_KINDS) {
      const source = `> [!${kind.toUpperCase()}]\n> body\n`;
      const found = scan(source);
      expect(found.map((c) => c.kind)).toEqual([kind]);
    }
  });

  it("matches the kind case-insensitively, as GitHub does", () => {
    for (const spelling of ["[!warning]", "[!Warning]", "[!WaRnInG]"]) {
      expect(scan(`> ${spelling}\n> body\n`).map((c) => c.kind)).toEqual(["warning"]);
    }
  });

  it("normalises the kind to lower case regardless of source spelling", () => {
    expect(scan("> [!TIP]\n> body\n")[0].kind).toBe("tip");
  });

  it("tolerates trailing whitespace after the marker", () => {
    expect(scan("> [!NOTE]   \n> body\n").map((c) => c.kind)).toEqual(["note"]);
  });

  it("ignores an unknown kind", () => {
    expect(scan("> [!DANGER]\n> body\n")).toEqual([]);
  });

  it("ignores a marker that shares its line with other text", () => {
    // GitHub requires the marker to stand alone on the blockquote's first
    // line; `> [!NOTE] hello` is a plain blockquote there, and here too.
    expect(scan("> [!NOTE] hello\n> body\n")).toEqual([]);
  });

  it("ignores a marker that is not the blockquote's first line", () => {
    expect(scan("> intro\n> [!NOTE]\n> body\n")).toEqual([]);
  });

  it("ignores whitespace inside the brackets", () => {
    expect(scan("> [! NOTE]\n> body\n")).toEqual([]);
    expect(scan("> [!NOTE ]\n> body\n")).toEqual([]);
  });

  it("ignores a marker inside a fenced code block", () => {
    const source = "```\n> [!WARNING]\n> body\n```\n";
    expect(scan(source)).toEqual([]);
  });

  it("recognises a callout with no body", () => {
    expect(scan("> [!TIP]\n").map((c) => c.kind)).toEqual(["tip"]);
  });

  it("recognises a nested callout at its own depth, without double-counting", () => {
    const source = "> [!NOTE]\n> > [!WARNING]\n> > inner\n";
    // The outer blockquote's own first line is `[!NOTE]`; the inner one's is
    // `[!WARNING]`. Each is reported exactly once, at its own nesting depth.
    expect(scan(source).map((c) => c.kind)).toEqual(["note", "warning"]);
  });

  it("does not treat a nested marker as the outer blockquote's marker", () => {
    const source = "> > [!WARNING]\n> > inner\n";
    expect(scan(source).map((c) => c.kind)).toEqual(["warning"]);
  });

  it("reports the marker's exact source offsets and the marker line's span", () => {
    const source = "intro\n\n> [!WARNING]\n> body\n";
    const [callout] = scan(source);
    expect(source.slice(callout.markerFrom, callout.markerTo)).toBe("[!WARNING]");
    expect(source.slice(callout.lineFrom, callout.lineTo)).toBe("> [!WARNING]");
  });

  it("spans the whole blockquote, not just the marker line", () => {
    const source = "> [!NOTE]\n> a\n> b\n\nafter\n";
    const [callout] = scan(source);
    expect(callout.fromLine).toBe(0);
    expect(callout.toLine).toBe(3);
  });
});

describe("calloutsProducer", () => {
  it("marks every quoted line of the callout with a kind-specific class", () => {
    const source = "> [!WARNING]\n> one\n> two\n";
    const lines = lineDecs(emitted(source));
    expect(lines.map((d) => d.from)).toEqual([0, 13, 19]);
    for (const l of lines) {
      expect(l.class).toContain("cm-md-callout");
      expect(l.class).toContain("cm-md-callout-warning");
    }
  });

  it("names the kind in an attribute so it is not carried by colour alone", () => {
    const source = "> [!CAUTION]\n> body\n";
    const first = lineDecs(emitted(source))[0];
    expect(first.attributes?.["data-callout"]).toBe("caution");
    expect(first.attributes?.role).toBe("note");
    expect(first.attributes?.["aria-label"]).toBe(calloutLabel("caution"));
  });

  it("brackets the block so the first and last line can be rounded off", () => {
    const source = "> [!TIP]\n> one\n> two\n";
    const lines = lineDecs(emitted(source));
    expect(lines[0].class).toContain("cm-md-callout-first");
    expect(lines[0].class).not.toContain("cm-md-callout-last");
    expect(lines[2].class).toContain("cm-md-callout-last");
  });

  it("marks the [!KIND] text so edit mode can mute it while keeping it visible", () => {
    const source = "> [!IMPORTANT]\n> body\n";
    const marks = markDecs(emitted(source));
    expect(marks).toHaveLength(1);
    expect(source.slice(marks[0].from, marks[0].to)).toBe("[!IMPORTANT]");
    expect(marks[0].class).toBe("cm-md-callout-marker");
  });

  it("produces nothing for a plain blockquote", () => {
    expect(emitted("> just a quote\n> more\n")).toEqual([]);
  });

  it("lets the innermost callout own a line shared with an outer one", () => {
    const source = "> [!NOTE]\n> > [!WARNING]\n> > inner\n";
    const lines = lineDecs(emitted(source));
    // One decoration per source line, and the nested lines read as WARNING.
    expect(lines).toHaveLength(3);
    expect(lines[0].class).toContain("cm-md-callout-note");
    expect(lines[1].class).toContain("cm-md-callout-warning");
    expect(lines[2].class).toContain("cm-md-callout-warning");
  });

  it("decorates Karl's reported block as a warning callout", () => {
    const source = [
      "> [!WARNING]",
      "> The RG40XXV boots entirely from MicroSD — there is no internal eMMC to",
      "> fall back on. Writing this firmware to the card **destroys the stock",
      "> Anbernic OS on it**. Use a spare card, or image your original card first",
      "> (`dd if=/dev/rdiskN of=stock-backup.img bs=4m`). Keeping the stock card",
      "> intact also gives you a known-good way to confirm the hardware still",
      "> works.",
      "",
    ].join("\n");
    const lines = lineDecs(emitted(source));
    expect(lines).toHaveLength(7);
    for (const l of lines) expect(l.class).toContain("cm-md-callout-warning");
  });
});

describe("readingWidgetsProducer for callouts", () => {
  interface Reading {
    from: number;
    to: number;
    widget?: { constructor: { name: string }; toDOM: () => HTMLElement };
    class?: string;
  }

  function reading(source: string): Reading[] {
    const tokens = parseMarkdown(source);
    const set = readingWidgetsProducer({ source, tokens });
    const out: Reading[] = [];
    const cursor = set.iter();
    while (cursor.value) {
      const spec = cursor.value.spec as Omit<Reading, "from" | "to">;
      out.push({ from: cursor.from, to: cursor.to, widget: spec.widget, class: spec.class });
      cursor.next();
    }
    return out;
  }

  const titles = (all: Reading[]) =>
    all.filter((d) => d.widget?.constructor.name === "CalloutTitleWidget");

  it("replaces the whole marker line, `> ` prefix included, with a title widget", () => {
    const source = "> [!WARNING]\n> body\n";
    const found = titles(reading(source));
    expect(found).toHaveLength(1);
    expect(source.slice(found[0].from, found[0].to)).toBe("> [!WARNING]");
  });

  it("shows the kind as text and keeps the icon out of the accessibility tree", () => {
    const dom = titles(reading("> [!CAUTION]\n> body\n"))[0].widget!.toDOM();
    expect(dom.textContent).toContain(calloutLabel("caution"));
    const icon = dom.querySelector(".cm-md-callout-icon");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
    // The label is real text, so the kind survives without colour or icon.
    expect(dom.querySelector(".cm-md-callout-label")!.textContent).toBe(
      calloutLabel("caution"),
    );
  });

  it("gives each kind its own widget identity so CM redraws on a kind change", () => {
    const warn = titles(reading("> [!WARNING]\n> body\n"))[0].widget!;
    const note = titles(reading("> [!NOTE]\n> body\n"))[0].widget!;
    const warn2 = titles(reading("> [!WARNING]\n> other\n"))[0].widget!;
    const eq = (a: unknown, b: unknown) => (a as { eq: (o: unknown) => boolean }).eq(b);
    expect(eq(warn, note)).toBe(false);
    expect(eq(warn, warn2)).toBe(true);
  });

  it("does not also elide the marker line's `> ` prefix", () => {
    // Two decorations starting at the same offset would collide in the
    // producer's dedup pass and the wider title replace would lose.
    const source = "> [!NOTE]\n> body\n";
    const atLineStart = reading(source).filter((d) => d.from === 0);
    expect(atLineStart).toHaveLength(1);
    expect(atLineStart[0].widget?.constructor.name).toBe("CalloutTitleWidget");
  });

  it("still elides the `> ` prefix on the callout's body lines", () => {
    const source = "> [!NOTE]\n> body\n";
    const bodyStart = source.indexOf("> body");
    const atBody = reading(source).filter((d) => d.from === bodyStart);
    expect(atBody).toHaveLength(1);
    expect(atBody[0].class).toBe("cm-md-reading-elide");
  });

  it("does not reflow the body up onto the title row", () => {
    // The marker line and the body are one markdown-it paragraph, so the
    // paragraph-reflow soft break would otherwise merge them into one line.
    const source = "> [!WARNING]\n> body\n";
    const newline = source.indexOf("\n");
    const softBreaks = reading(source).filter(
      (d) => d.widget?.constructor.name === "SoftBreakWidget" && d.from === newline,
    );
    expect(softBreaks).toEqual([]);
  });

  it("leaves a plain blockquote's prefix elision alone", () => {
    const source = "> just a quote\n";
    const all = reading(source);
    expect(titles(all)).toEqual([]);
    expect(all.filter((d) => d.from === 0)[0].class).toBe("cm-md-reading-elide");
  });
});

describe("callouts in a live EditorView", () => {
  function render(source: string, producers: typeof markdownFormat.readingProducers) {
    const dom = new JSDOM('<!doctype html><div id="host"></div>');
    globalThis.document = dom.window.document;
    const host = dom.window.document.getElementById("host")!;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: source, extensions: [buildDecorationField(producers)] }),
    });
    const html = view.dom.textContent ?? "";
    const root = view.dom;
    return { html, root, view };
  }

  const KARLS_BLOCK = [
    "> [!WARNING]",
    "> The RG40XXV boots entirely from MicroSD — there is no internal eMMC to",
    "> fall back on.",
    "",
  ].join("\n");

  it("renders the reported block as a titled callout, marker text gone", () => {
    const { html, root } = render(KARLS_BLOCK, markdownFormat.readingProducers);
    expect(html).not.toContain("[!WARNING]");
    expect(html).toContain(calloutLabel("warning"));
    expect(root.querySelector(".cm-md-callout-warning")).not.toBeNull();
    expect(root.querySelector(".cm-md-blockquote")).toBeNull();
    // The kind is announced, not merely coloured.
    expect(root.querySelector('[role="note"]')?.getAttribute("aria-label")).toBe(
      calloutLabel("warning"),
    );
  });

  it("keeps the marker visible but muted in edit mode", () => {
    const { html, root } = render(KARLS_BLOCK, markdownFormat.editingProducers);
    expect(html).toContain("[!WARNING]");
    expect(root.querySelector(".cm-md-callout-marker")).not.toBeNull();
    expect(root.querySelector(".cm-md-callout-title")).toBeNull();
  });

  it("still renders a plain blockquote as a blockquote in reading mode", () => {
    const { root } = render("> just a quote\n", markdownFormat.readingProducers);
    expect(root.querySelector(".cm-md-blockquote")).not.toBeNull();
    expect(root.querySelector(".cm-md-callout")).toBeNull();
  });
});

describe("calloutsProducer registration", () => {
  // Four separate places build a producer list, and a producer missing from
  // one of them renders in the app but not the website (or the other way
  // round) with nothing failing. Keep all four honest.
  const SITES = [
    "src/main.ts",
    "src/mobile-bootstrap.ts",
    "src/format/markdown.ts",
    "src/website/bootstrap.ts",
  ];

  // A callout *is* a blockquote to the parser, so the two producers must be
  // wired up in lockstep: every list that names one has to name the other, or
  // callout lines fall through to the plain-blockquote rendering on whichever
  // surface was missed. Counting list entries (not mere mentions) is what
  // catches a file where only one of its two lists was updated.
  const entries = (text: string, name: string) =>
    text.split("\n").filter((l) => l.trim() === `${name},`).length;

  for (const site of SITES) {
    it(`${site} registers calloutsProducer wherever it registers blockquotesProducer`, () => {
      const text = readFileSync(resolve(process.cwd(), site), "utf8");
      const quotes = entries(text, "blockquotesProducer");
      expect(quotes).toBeGreaterThan(0);
      expect(entries(text, "calloutsProducer")).toBe(quotes);
    });
  }

  it("is in both the editing and the reading producer sets", () => {
    expect(markdownFormat.editingProducers).toContain(calloutsProducer);
    expect(markdownFormat.readingProducers).toContain(calloutsProducer);
  });
});

describe("blockquotesProducer alongside callouts", () => {
  function quotedLines(source: string) {
    const tokens = parseMarkdown(source);
    const set = blockquotesProducer({ source, tokens });
    const out: number[] = [];
    const cursor = set.iter();
    while (cursor.value) {
      out.push(cursor.from);
      cursor.next();
    }
    return out;
  }

  it("leaves callout lines to the callout producer", () => {
    expect(quotedLines("> [!WARNING]\n> body\n")).toEqual([]);
  });

  it("still claims a plain blockquote", () => {
    expect(quotedLines("> a\n> b\nc\n")).toEqual([0, 4]);
  });

  it("claims the plain lines of a quote that merely contains a callout", () => {
    const source = "> plain\n>\n> > [!NOTE]\n> > inner\n";
    expect(quotedLines(source)).toEqual([0, 8]);
  });
});
