import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";

import {
  resolveLinkAt,
  classifyLink,
  slugifyHeading,
  buildAnchorIndex,
  linkClickExtension,
  type LinkClickHandlers,
} from "../../src/editor/link-clicks";
import { createEditor, setMode } from "../../src/editor/editor";
import { StateEffect } from "@codemirror/state";

describe("resolveLinkAt", () => {
  it("returns the href for a click inside an inline link's text", () => {
    const src = "see [docs](https://example.com) here\n";
    // "docs" is at offsets 5..9
    const r = resolveLinkAt(src, 6);
    expect(r?.href).toBe("https://example.com");
  });

  it("returns the href for a click inside an inline link's url span", () => {
    const src = "see [docs](https://example.com) here\n";
    // "(https://…)" begins at offset 10
    const r = resolveLinkAt(src, 20);
    expect(r?.href).toBe("https://example.com");
  });

  it("returns the href for an autolink", () => {
    const src = "see https://example.com here\n";
    const r = resolveLinkAt(src, 10);
    expect(r?.href).toBe("https://example.com");
  });

  it("returns null when the click isn't on a link", () => {
    const src = "see [docs](https://example.com) here\n";
    // offset 0 is "s" of "see"
    const r = resolveLinkAt(src, 0);
    expect(r).toBeNull();
  });

  it("handles relative links", () => {
    const src = "go [there](./other.md) next\n";
    const r = resolveLinkAt(src, 5);
    expect(r?.href).toBe("./other.md");
  });

  it("handles anchor-only hrefs", () => {
    const src = "jump [up](#intro) here\n";
    const r = resolveLinkAt(src, 7);
    expect(r?.href).toBe("#intro");
  });
});

describe("classifyLink", () => {
  it("classifies https as external", () => {
    expect(classifyLink("https://example.com")).toEqual({
      kind: "external",
      url: "https://example.com",
    });
  });
  it("classifies http as external", () => {
    expect(classifyLink("http://x")).toEqual({ kind: "external", url: "http://x" });
  });
  it("classifies mailto as external", () => {
    expect(classifyLink("mailto:a@b.c")).toEqual({
      kind: "external",
      url: "mailto:a@b.c",
    });
  });
  it("classifies a bare #anchor as anchor", () => {
    expect(classifyLink("#intro")).toEqual({ kind: "anchor", slug: "intro" });
  });
  it("classifies relative .md as local-md", () => {
    expect(classifyLink("./other.md")).toEqual({
      kind: "local-md",
      rawPath: "./other.md",
    });
  });
  it("classifies a .markdown extension as local-md", () => {
    expect(classifyLink("docs/x.markdown")).toEqual({
      kind: "local-md",
      rawPath: "docs/x.markdown",
    });
  });
  it("keeps local-md when the href has a fragment", () => {
    expect(classifyLink("./other.md#section")).toEqual({
      kind: "local-md",
      rawPath: "./other.md#section",
    });
  });
  it("falls back to 'other' for unknown extensions", () => {
    expect(classifyLink("./image.png")).toEqual({
      kind: "other",
      url: "./image.png",
    });
  });
  it("treats custom schemes as 'other' (defer to OS)", () => {
    expect(classifyLink("vscode://file/x")).toEqual({
      kind: "other",
      url: "vscode://file/x",
    });
  });
});

describe("slugifyHeading", () => {
  it("lowercases and dashes", () => {
    expect(slugifyHeading("Hello World")).toBe("hello-world");
  });
  it("strips punctuation", () => {
    expect(slugifyHeading("What's Up?")).toBe("whats-up");
  });
  it("collapses repeated dashes", () => {
    expect(slugifyHeading("a   b")).toBe("a-b");
  });
  it("preserves non-ASCII letters", () => {
    expect(slugifyHeading("Räksmörgås")).toBe("räksmörgås");
  });
});

describe("buildAnchorIndex", () => {
  it("maps slugs to source offsets", () => {
    const src = "# First\n\n## Second Heading\n";
    const idx = buildAnchorIndex(src);
    expect(idx.get("first")).toBe(0);
    expect(idx.get("second-heading")).toBe(9);
  });
});

describe("linkClickExtension (integration)", () => {
  let host: HTMLElement;

  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>');
    globalThis.document = dom.window.document;
    // CodeMirror reads getComputedStyle / etc. from window — propagate.
    (globalThis as unknown as { window: Window }).window =
      dom.window as unknown as Window;
    host = dom.window.document.getElementById("host")!;
  });

  function buildHandlers(): {
    handlers: LinkClickHandlers;
    spies: {
      openExternal: ReturnType<typeof vi.fn>;
      openLocalMarkdown: ReturnType<typeof vi.fn>;
      resolveRelativeMarkdown: ReturnType<typeof vi.fn>;
      scrollToAnchor: ReturnType<typeof vi.fn>;
    };
  } {
    const spies = {
      openExternal: vi.fn(async () => {}),
      openLocalMarkdown: vi.fn(async () => {}),
      resolveRelativeMarkdown: vi.fn(async (raw: string) => `/docs/${raw}`),
      scrollToAnchor: vi.fn((_: string) => true),
    };
    return { handlers: spies as unknown as LinkClickHandlers, spies };
  }

  /** Simulate a click at a known source offset by stubbing posAtDOM. */
  function clickAt(view: import("@codemirror/view").EditorView, pos: number) {
    const ev = new (host.ownerDocument!.defaultView as unknown as {
      MouseEvent: typeof MouseEvent;
    }).MouseEvent("click", { bubbles: true, cancelable: true });
    // Force CM's posAtDOM lookup to return our offset regardless of layout
    // (jsdom has no real layout, so posAtDOM is unreliable on widget-heavy
    // docs — but for our test we only need the resolver to see `pos`).
    const orig = view.posAtDOM.bind(view);
    view.posAtDOM = () => pos;
    try {
      // Find the registered click handler on view.dom and dispatch through it.
      view.contentDOM.dispatchEvent(ev);
    } finally {
      view.posAtDOM = orig;
    }
    return ev;
  }

  it("invokes openExternal on an external link in reading mode", async () => {
    const src = "see [docs](https://example.com) here\n";
    const view = createEditor({ parent: host, source: src });
    const { handlers, spies } = buildHandlers();
    view.dispatch({
      effects: StateEffect.appendConfig.of(linkClickExtension(handlers)),
    });
    clickAt(view, 6); // inside "docs"
    // openExternal is async-fire-and-forget — flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(spies.openExternal).toHaveBeenCalledWith("https://example.com");
    expect(spies.openLocalMarkdown).not.toHaveBeenCalled();
  });

  it("invokes openExternal on an autolink", async () => {
    const src = "see https://example.com here\n";
    const view = createEditor({ parent: host, source: src });
    const { handlers, spies } = buildHandlers();
    view.dispatch({
      effects: StateEffect.appendConfig.of(linkClickExtension(handlers)),
    });
    clickAt(view, 10);
    await new Promise((r) => setTimeout(r, 0));
    expect(spies.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("invokes openLocalMarkdown for a relative .md link", async () => {
    const src = "go [there](./other.md) next\n";
    const view = createEditor({ parent: host, source: src });
    const { handlers, spies } = buildHandlers();
    view.dispatch({
      effects: StateEffect.appendConfig.of(linkClickExtension(handlers)),
    });
    clickAt(view, 5);
    await new Promise((r) => setTimeout(r, 0));
    expect(spies.resolveRelativeMarkdown).toHaveBeenCalledWith("./other.md");
    expect(spies.openLocalMarkdown).toHaveBeenCalledWith("/docs/./other.md");
    expect(spies.openExternal).not.toHaveBeenCalled();
  });

  it("scrolls (not navigates) for an in-document anchor link", async () => {
    const src = "# Intro\n\njump [up](#intro) here\n";
    const view = createEditor({ parent: host, source: src });
    const { handlers, spies } = buildHandlers();
    view.dispatch({
      effects: StateEffect.appendConfig.of(linkClickExtension(handlers)),
    });
    // Click in the "[up]" link text on line 3
    const idx = src.indexOf("[up]") + 2;
    clickAt(view, idx);
    await new Promise((r) => setTimeout(r, 0));
    expect(spies.scrollToAnchor).toHaveBeenCalledWith("intro");
    expect(spies.openExternal).not.toHaveBeenCalled();
    expect(spies.openLocalMarkdown).not.toHaveBeenCalled();
  });

  it("does NOT invoke handlers in edit mode", async () => {
    const src = "see [docs](https://example.com) here\n";
    const view = createEditor({ parent: host, source: src });
    const { handlers, spies } = buildHandlers();
    view.dispatch({
      effects: StateEffect.appendConfig.of(linkClickExtension(handlers)),
    });
    setMode(view, "edit");
    clickAt(view, 6);
    await new Promise((r) => setTimeout(r, 0));
    expect(spies.openExternal).not.toHaveBeenCalled();
    expect(spies.openLocalMarkdown).not.toHaveBeenCalled();
  });

  it("ignores clicks outside any link", async () => {
    const src = "plain text with no link\n";
    const view = createEditor({ parent: host, source: src });
    const { handlers, spies } = buildHandlers();
    view.dispatch({
      effects: StateEffect.appendConfig.of(linkClickExtension(handlers)),
    });
    clickAt(view, 3);
    await new Promise((r) => setTimeout(r, 0));
    expect(spies.openExternal).not.toHaveBeenCalled();
    expect(spies.openLocalMarkdown).not.toHaveBeenCalled();
  });
});
