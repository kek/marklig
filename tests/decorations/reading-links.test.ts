import { describe, it, expect, vi } from "vitest";

import { parseMarkdown } from "../../src/editor/parser";
import {
  readingLinkWidgetsProducer,
  isExternalLinkScheme,
  setLinkOpener,
  LinkWidget,
} from "../../src/editor/decorations/reading-links";

interface WidgetEntry {
  from: number;
  to: number;
  widget: LinkWidget;
}

function linkWidgets(source: string): WidgetEntry[] {
  const tokens = parseMarkdown(source);
  const set = readingLinkWidgetsProducer({ source, tokens });
  const out: WidgetEntry[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    const spec = cursor.value.spec as { widget?: unknown };
    if (spec.widget instanceof LinkWidget) {
      out.push({ from: cursor.from, to: cursor.to, widget: spec.widget });
    }
    cursor.next();
  }
  return out;
}

describe("isExternalLinkScheme", () => {
  it("accepts http and https", () => {
    expect(isExternalLinkScheme("http://example.com")).toBe(true);
    expect(isExternalLinkScheme("https://example.com")).toBe(true);
    expect(isExternalLinkScheme("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it("rejects dangerous and non-web schemes", () => {
    expect(isExternalLinkScheme("javascript:alert(1)")).toBe(false);
    expect(isExternalLinkScheme("file:///etc/passwd")).toBe(false);
    expect(isExternalLinkScheme("data:text/html,<b>x</b>")).toBe(false);
    expect(isExternalLinkScheme("mailto:a@b.com")).toBe(false);
    expect(isExternalLinkScheme("./relative.md")).toBe(false);
    expect(isExternalLinkScheme("#anchor")).toBe(false);
    expect(isExternalLinkScheme("")).toBe(false);
  });
});

describe("readingLinkWidgetsProducer", () => {
  it("replaces an inline [text](url) with a LinkWidget over the whole construct, showing only the text", () => {
    const src = "see [docs](https://example.com) here\n";
    const w = linkWidgets(src);
    expect(w).toHaveLength(1);
    // The replace range covers the whole `[docs](https://example.com)`.
    expect(w[0].from).toBe(4);
    expect(w[0].to).toBe(31);
    const a = w[0].widget.toDOM() as HTMLAnchorElement;
    expect(a.tagName).toBe("A");
    expect(a.textContent).toBe("docs");
    expect(a.getAttribute("href")).toBe("https://example.com");
  });

  it("renders a bare autolink URL as a LinkWidget", () => {
    const src = "see https://example.com here\n";
    const w = linkWidgets(src);
    expect(w).toHaveLength(1);
    const a = w[0].widget.toDOM() as HTMLAnchorElement;
    expect(a.tagName).toBe("A");
    expect(a.textContent).toBe("https://example.com");
    expect(a.getAttribute("href")).toBe("https://example.com");
  });

  it("does not replace non-http(s) inline links (left to text elision + click handler)", () => {
    expect(linkWidgets("see [home](./index.md) here\n")).toHaveLength(0);
    expect(linkWidgets("see [x](javascript:alert(1)) here\n")).toHaveLength(0);
    expect(linkWidgets("see [top](#intro) here\n")).toHaveLength(0);
  });

  it("does not emit widgets for links inside fenced code", () => {
    const src = "```\n[docs](https://example.com)\n```\n";
    expect(linkWidgets(src)).toHaveLength(0);
  });

  it("emits an <a> announced as a link with the resolved accessible name", () => {
    const src = "[docs](https://example.com)\n";
    const a = linkWidgets(src)[0].widget.toDOM() as HTMLAnchorElement;
    // A real anchor with an href is announced as a link; no explicit role needed.
    expect(a.tagName).toBe("A");
    expect(a.hasAttribute("href")).toBe(true);
  });
});

describe("LinkWidget activation", () => {
  it("opens http/https externally on click and prevents default + propagation", () => {
    const opener = vi.fn();
    setLinkOpener(opener);
    try {
      const a = new LinkWidget("https://example.com", "docs").toDOM();
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      const stop = vi.spyOn(ev, "stopPropagation");
      a.dispatchEvent(ev);
      expect(opener).toHaveBeenCalledWith("https://example.com");
      expect(ev.defaultPrevented).toBe(true);
      expect(stop).toHaveBeenCalled();
    } finally {
      setLinkOpener(null);
    }
  });

  it("activates on Enter and Space", () => {
    const opener = vi.fn();
    setLinkOpener(opener);
    try {
      const a = new LinkWidget("https://example.com", "docs").toDOM();
      const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      a.dispatchEvent(enter);
      const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      a.dispatchEvent(space);
      expect(opener).toHaveBeenCalledTimes(2);
    } finally {
      setLinkOpener(null);
    }
  });

  it("never opens a non-http(s) scheme even if a widget is somehow constructed with one", () => {
    const opener = vi.fn();
    setLinkOpener(opener);
    try {
      const a = new LinkWidget("javascript:alert(1)", "x").toDOM();
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(opener).not.toHaveBeenCalled();
    } finally {
      setLinkOpener(null);
    }
  });
});
