import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { computeDocStats, mountToolbar } from "../../src/ui/toolbar";

let host: HTMLElement;
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="host"></div>');
  globalThis.document = dom.window.document;
  host = dom.window.document.getElementById("host")!;
});

function makeView(): EditorView {
  return new EditorView({
    state: EditorState.create({ doc: "" }),
    parent: host,
  });
}

describe("mountToolbar icon buttons", () => {
  it("renders Edit and TOC toggles as inline-SVG icon buttons", () => {
    const view = makeView();
    mountToolbar(host, {
      view,
      modeExtensions: {
        reading: { decorations: [], keymap: [] },
        edit: { decorations: [], keymap: [] },
      },
      initialMode: "reading",
    });
    const buttons = host.querySelectorAll<HTMLButtonElement>(".viewer-toolbar-btn");
    // First button is the mode toggle, second is the TOC toggle.
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    const [editBtn, tocBtn] = [buttons[0], buttons[1]];

    // Both render an inline <svg> child (no text label).
    expect(editBtn.querySelector("svg")).not.toBeNull();
    expect(tocBtn.querySelector("svg")).not.toBeNull();
    expect(editBtn.textContent?.trim()).toBe("");
    expect(tocBtn.textContent?.trim()).toBe("");

    // Both expose a localized aria-label and a tooltip via title.
    expect(editBtn.getAttribute("aria-label")).toBeTruthy();
    expect(editBtn.getAttribute("title")).toBeTruthy();
    expect(tocBtn.getAttribute("aria-label")).toBeTruthy();
    expect(tocBtn.getAttribute("title")).toBeTruthy();

    // Icon variant class is applied so the CSS knows to size as a square hit
    // target instead of the default text-button padding.
    expect(editBtn.classList.contains("viewer-toolbar-btn--icon")).toBe(true);
    expect(tocBtn.classList.contains("viewer-toolbar-btn--icon")).toBe(true);
  });

  it("reflects edit mode and sidebar visibility via aria-pressed", () => {
    const view = makeView();
    const handle = mountToolbar(host, {
      view,
      modeExtensions: {
        reading: { decorations: [], keymap: [] },
        edit: { decorations: [], keymap: [] },
      },
      initialMode: "reading",
      initialSidebarVisible: false,
    });
    const buttons = host.querySelectorAll<HTMLButtonElement>(".viewer-toolbar-btn");
    const [editBtn, tocBtn] = [buttons[0], buttons[1]];

    // Reading mode + sidebar hidden → both pressed=false.
    expect(editBtn.getAttribute("aria-pressed")).toBe("false");
    expect(tocBtn.getAttribute("aria-pressed")).toBe("false");

    handle.setMode("edit");
    expect(editBtn.getAttribute("aria-pressed")).toBe("true");

    handle.setSidebarVisible(true);
    expect(tocBtn.getAttribute("aria-pressed")).toBe("true");

    handle.setSidebarVisible(false);
    expect(tocBtn.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("computeDocStats", () => {
  it("returns zero for an empty document", () => {
    const s = computeDocStats("");
    expect(s.words).toBe(0);
    expect(s.chars).toBe(0);
    expect(s.readingMinutes).toBe(0);
  });

  it("counts words split on whitespace", () => {
    const s = computeDocStats("Hello world\nthis is markdown.");
    expect(s.words).toBe(5);
  });

  it("excludes markdown syntax from word counts", () => {
    // # ** _ ` etc. shouldn't count as words. Inline code is stripped, so
    // 'code' isn't counted; 'Title', 'bold', and 'em' are.
    const s = computeDocStats("# Title\n\n**bold** _em_ `code`");
    expect(s.words).toBe(3);
  });

  it("excludes fenced code from word counts", () => {
    const s = computeDocStats("Intro paragraph.\n\n```js\nconst x = 1;\n```\n\nOutro.");
    // Intro paragraph. + Outro. = 3 words; 'const x = 1;' is excluded.
    expect(s.words).toBe(3);
  });

  it("excludes inline code from word counts", () => {
    const s = computeDocStats("Run `git status` to see things.");
    // Run, to, see, things → 4
    expect(s.words).toBe(4);
  });

  it("strips HTML tags before counting", () => {
    const s = computeDocStats("Hello <strong>world</strong>!");
    expect(s.words).toBe(2);
  });

  it("char count is raw source length (markdown syntax included)", () => {
    const src = "# Hi";
    expect(computeDocStats(src).chars).toBe(src.length);
  });

  it("reading time is at least 1 minute for non-empty docs", () => {
    expect(computeDocStats("one").readingMinutes).toBe(1);
  });

  it("reading time scales with word count at ~200 wpm", () => {
    const words = Array.from({ length: 600 }, () => "word").join(" ");
    expect(computeDocStats(words).readingMinutes).toBe(3);
  });
});
