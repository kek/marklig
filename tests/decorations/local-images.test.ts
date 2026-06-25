import { describe, it, expect } from "vitest";

import {
  classifyImageSrc,
  isAbsoluteLike,
  localImageCache,
} from "../../src/editor/decorations/local-images";

/** Wait for a cache entry to appear (the disk read errors in jsdom — no Tauri
 * IPC — so a fired request resolves to an `error` entry). */
async function waitForEntry(rawSrc: string, tries = 20): Promise<unknown> {
  for (let i = 0; i < tries; i++) {
    const e = localImageCache.get(rawSrc);
    if (e) return e;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  return localImageCache.get(rawSrc);
}

describe("classifyImageSrc", () => {
  it("treats http(s) URLs as remote", () => {
    expect(classifyImageSrc("https://example.com/a.png")).toBe("remote");
    expect(classifyImageSrc("http://example.com/a.png")).toBe("remote");
  });

  it("treats protocol-relative URLs as remote", () => {
    expect(classifyImageSrc("//example.com/a.png")).toBe("remote");
  });

  it("treats data URLs as data", () => {
    expect(classifyImageSrc("data:image/png;base64,AAAA")).toBe("data");
  });

  it("treats relative filesystem paths as local", () => {
    expect(classifyImageSrc("docs/future-architecture.png")).toBe("local");
    expect(classifyImageSrc("./rel.png")).toBe("local");
    expect(classifyImageSrc("../up/rel.png")).toBe("local");
  });

  it("treats absolute filesystem paths as local", () => {
    expect(classifyImageSrc("/Users/ke/x.png")).toBe("local");
    expect(classifyImageSrc("C:\\Users\\ke\\x.png")).toBe("local");
  });
});

describe("isAbsoluteLike", () => {
  it("is true for POSIX and Windows absolute paths", () => {
    expect(isAbsoluteLike("/Users/ke/x.png")).toBe(true);
    expect(isAbsoluteLike("C:\\Users\\ke\\x.png")).toBe(true);
    expect(isAbsoluteLike("C:/Users/ke/x.png")).toBe(true);
    expect(isAbsoluteLike("\\\\server\\share\\x.png")).toBe(true);
  });
  it("is false for relative paths", () => {
    expect(isAbsoluteLike("docs/x.png")).toBe(false);
    expect(isAbsoluteLike("./x.png")).toBe(false);
    expect(isAbsoluteLike("../x.png")).toBe(false);
  });
});

describe("localImageCache", () => {
  it("does not fire a request for a relative path while no document is open", async () => {
    // Regression: the original design fired a request with a null doc path,
    // cached a failure under a null key, and relied on a fragile self-healing
    // recompute to recover — which hung on 'Loading…' in release builds. A
    // relative path with no open document must be a no-op (no cached entry).
    localImageCache.setDocPathGetter(() => null);
    localImageCache.request("only/relative/never-open.png");
    const entry = await waitForEntry("only/relative/never-open.png", 5);
    expect(entry).toBeUndefined();
  });

  it("keys entries by document path so one document's image never shadows another's", async () => {
    // Resolve against doc A: a relative src gets an entry under A's key.
    localImageCache.setDocPathGetter(() => "/docs/a/README.md");
    localImageCache.request("img/shared-name.png");
    const underA = await waitForEntry("img/shared-name.png");
    expect(underA).toBeDefined(); // errors in jsdom, but the entry exists

    // Switch to doc B in a different directory: the same relative src must MISS
    // (different key), forcing a fresh resolve against B — not reuse A's entry.
    localImageCache.setDocPathGetter(() => "/docs/b/README.md");
    expect(localImageCache.get("img/shared-name.png")).toBeUndefined();
  });

  it("releaseExcept keeps the current document's entries and drops the rest", async () => {
    localImageCache.setDocPathGetter(() => "/docs/keep/README.md");
    localImageCache.request("k.png");
    await waitForEntry("k.png");
    localImageCache.setDocPathGetter(() => "/docs/gone/README.md");
    localImageCache.request("g.png");
    await waitForEntry("g.png");

    // Keep only the "keep" document's entries.
    localImageCache.releaseExcept("/docs/keep/README.md");

    localImageCache.setDocPathGetter(() => "/docs/keep/README.md");
    expect(localImageCache.get("k.png")).toBeDefined();
    localImageCache.setDocPathGetter(() => "/docs/gone/README.md");
    expect(localImageCache.get("g.png")).toBeUndefined();
  });
});
