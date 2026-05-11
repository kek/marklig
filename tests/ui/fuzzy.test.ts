import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

import { scoreMatch, buildHighlightedSpans } from "../../src/ui/fuzzy";

describe("scoreMatch", () => {
  it("returns score 0 and no positions for an empty query (matches all)", () => {
    const m = scoreMatch("docs/intro.md", "");
    expect(m).not.toBeNull();
    expect(m!.score).toBe(0);
    expect(m!.positions).toEqual([]);
  });

  it("returns null when query chars don't all appear in order", () => {
    expect(scoreMatch("readme.md", "xyz")).toBeNull();
    // Out of order: 'md' chars exist but reversed
    expect(scoreMatch("a-b", "ba")).toBeNull();
  });

  it("matches only when query characters appear in order", () => {
    const m = scoreMatch("docs/intro.md", "din");
    expect(m).not.toBeNull();
    // d=0, i=5, n=6 (after "docs/")
    expect(m!.positions).toEqual([0, 5, 6]);
  });

  it("is case-insensitive", () => {
    const a = scoreMatch("README.md", "rd");
    const b = scoreMatch("readme.md", "RD");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.positions).toEqual(b!.positions);
  });

  it("boosts a basename-start match over a mid-path match", () => {
    // "intro" — at basename start in candidate A, deep mid-path in B
    const a = scoreMatch("docs/intro.md", "intro");
    const b = scoreMatch("intro/notes/other.md", "intro");
    // B starts at offset 0 (basename of "intro/notes/other.md" is "other.md"
    // — the query chars match the *parent* dir). A has all 5 chars contiguous
    // at the basename start ("intro" in "intro.md").
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.score).toBeGreaterThan(b!.score);
  });

  it("boosts contiguous runs over scattered matches", () => {
    const tight = scoreMatch("introduction.md", "intro");
    const loose = scoreMatch("indexnotrelevantotherwise.md", "intro");
    expect(tight).not.toBeNull();
    expect(loose).not.toBeNull();
    expect(tight!.score).toBeGreaterThan(loose!.score);
  });

  it("handles a Windows-style backslash separator for basename detection", () => {
    const m = scoreMatch("docs\\guide.md", "guide");
    expect(m).not.toBeNull();
    // Basename starts after "\\"; first match at that index should get the boost.
    const baseScore = m!.score;
    const noBoost = scoreMatch("docsguide.md", "guide");
    expect(noBoost).not.toBeNull();
    expect(baseScore).toBeGreaterThanOrEqual(noBoost!.score);
  });

  it("returns null on an empty candidate with a non-empty query", () => {
    expect(scoreMatch("", "x")).toBeNull();
  });
});

describe("buildHighlightedSpans", () => {
  beforeEach(() => {
    const dom = new JSDOM("<!doctype html><div id='host'></div>");
    globalThis.document = dom.window.document;
  });

  it("returns a single text node when there are no positions", () => {
    const nodes = buildHighlightedSpans("intro.md", []);
    expect(nodes.length).toBe(1);
    expect(nodes[0].nodeType).toBe(3 /* Text */);
    expect(nodes[0].textContent).toBe("intro.md");
  });

  it("wraps matched characters in <span class='viewer-fuzzy-match'>", () => {
    // Positions of 'i' (0), 'n' (1), 't' (2) — contiguous run -> one span
    const nodes = buildHighlightedSpans("intro.md", [0, 1, 2]);
    const host = document.getElementById("host")!;
    host.replaceChildren();
    for (const n of nodes) host.append(n);

    const spans = host.querySelectorAll("span.viewer-fuzzy-match");
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe("int");
    expect(host.textContent).toBe("intro.md");
  });

  it("emits one span per contiguous run of matches", () => {
    // Positions 0,1 and 4,5 of "intro.md" -> two separate runs
    const nodes = buildHighlightedSpans("intro.md", [0, 1, 4, 5]);
    const host = document.getElementById("host")!;
    host.replaceChildren();
    for (const n of nodes) host.append(n);

    const spans = host.querySelectorAll("span.viewer-fuzzy-match");
    expect(spans.length).toBe(2);
    expect(spans[0].textContent).toBe("in");
    expect(spans[1].textContent).toBe("o.");
    expect(host.textContent).toBe("intro.md");
  });

  it("preserves the unmatched suffix as a trailing text node", () => {
    const nodes = buildHighlightedSpans("intro.md", [0]);
    const host = document.getElementById("host")!;
    host.replaceChildren();
    for (const n of nodes) host.append(n);
    expect(host.textContent).toBe("intro.md");
    expect(host.querySelectorAll("span.viewer-fuzzy-match").length).toBe(1);
  });
});
