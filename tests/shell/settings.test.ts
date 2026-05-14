import { describe, it, expect, vi, beforeEach } from "vitest";

import { isRemoteUrl, shouldRenderImage } from "../../src/shell/settings";

// Spell-check store round-trip needs an in-memory mock of the Tauri store so
// the test isn't bound to a real plugin runtime.
const storeMem = new Map<string, unknown>();
vi.mock("../../src/shell/store", () => ({
  getValue: async (k: string) => storeMem.get(k),
  setValue: async (k: string, v: unknown) => {
    storeMem.set(k, v);
  },
  deleteValue: async (k: string) => {
    storeMem.delete(k);
  },
  listKeys: async () => Array.from(storeMem.keys()),
}));

describe("isRemoteUrl", () => {
  it("recognises http and https URLs", () => {
    expect(isRemoteUrl("http://example.com/x.png")).toBe(true);
    expect(isRemoteUrl("https://example.com/x.png")).toBe(true);
    expect(isRemoteUrl("HTTPS://example.com/x.png")).toBe(true);
  });

  it("recognises protocol-relative URLs", () => {
    expect(isRemoteUrl("//example.com/x.png")).toBe(true);
  });

  it("does not flag relative or absolute file paths as remote", () => {
    expect(isRemoteUrl("./img/x.png")).toBe(false);
    expect(isRemoteUrl("img/x.png")).toBe(false);
    expect(isRemoteUrl("/Users/ke/img.png")).toBe(false);
    expect(isRemoteUrl("file:///tmp/x.png")).toBe(false);
  });

  it("does not flag data: or blob: URIs as remote", () => {
    // These don't trigger network requests, so they aren't policy-gated.
    expect(isRemoteUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isRemoteUrl("blob:https://example.com/uuid")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isRemoteUrl("")).toBe(false);
  });
});

describe("spellcheck setting", () => {
  beforeEach(async () => {
    storeMem.clear();
    // Force the module's in-memory cache back to the default. loadSettings
    // is a no-op when the store is empty so it preserves whatever value the
    // previous test left behind — we explicitly reseed first.
    const { setSpellcheck } = await import("../../src/shell/settings");
    setSpellcheck(false);
    storeMem.clear();
  });

  it("defaults to false (must be OFF out of the box, per issue #63)", async () => {
    const { getSpellcheck, loadSettings } = await import("../../src/shell/settings");
    await loadSettings();
    expect(getSpellcheck()).toBe(false);
  });

  it("setSpellcheck persists to the store", async () => {
    const { setSpellcheck, getSpellcheck } = await import(
      "../../src/shell/settings"
    );
    setSpellcheck(true);
    expect(getSpellcheck()).toBe(true);
    // Persisted value lives in our in-memory mock store.
    expect(storeMem.get("spellcheck")).toBe(true);
  });

  it("loadSettings restores a persisted true value", async () => {
    const { getSpellcheck, setSpellcheck, loadSettings } = await import(
      "../../src/shell/settings"
    );
    // Pretend the user previously enabled it; in-memory has since drifted.
    storeMem.set("spellcheck", true);
    setSpellcheck(false); // simulate fresh module state
    storeMem.set("spellcheck", true); // setSpellcheck overwrote — restore
    await loadSettings();
    expect(getSpellcheck()).toBe(true);
  });

  it("notifies subscribers when changed", async () => {
    const { setSpellcheck, subscribeSettings } = await import(
      "../../src/shell/settings"
    );
    const calls = vi.fn();
    const unsub = subscribeSettings(calls);
    setSpellcheck(true);
    setSpellcheck(true); // no-op, value unchanged
    setSpellcheck(false);
    unsub();
    expect(calls).toHaveBeenCalledTimes(2);
  });
});

describe("shouldRenderImage", () => {
  it("always renders local images regardless of policy", () => {
    expect(shouldRenderImage("./x.png", "off")).toBe(true);
    expect(shouldRenderImage("./x.png", "placeholder")).toBe(true);
    expect(shouldRenderImage("./x.png", "load")).toBe(true);
  });

  it("renders remote images only when policy is 'load'", () => {
    const url = "https://example.com/x.png";
    expect(shouldRenderImage(url, "load")).toBe(true);
    expect(shouldRenderImage(url, "placeholder")).toBe(false);
    expect(shouldRenderImage(url, "off")).toBe(false);
  });
});
