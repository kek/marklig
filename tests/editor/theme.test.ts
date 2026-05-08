import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

import { applyTheme, loadStoredTheme, storeTheme } from "../../src/editor/theme";

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window as unknown as typeof globalThis.window;
  globalThis.localStorage = dom.window.localStorage;
  // jsdom doesn't implement matchMedia; stub a non-dark default.
  (globalThis.window as { matchMedia?: unknown }).matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

describe("applyTheme", () => {
  it("adds theme-light when theme is light", () => {
    applyTheme("light");
    expect(document.documentElement.classList.contains("theme-light")).toBe(true);
  });

  it("adds theme-dark when theme is dark", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("theme-dark")).toBe(true);
  });

  it("falls back to light when system prefers light", () => {
    applyTheme("system");
    expect(document.documentElement.classList.contains("theme-light")).toBe(true);
  });
});

describe("storage helpers", () => {
  it("round-trips theme through localStorage", () => {
    storeTheme("dark");
    expect(loadStoredTheme()).toBe("dark");
  });

  it("returns 'system' when nothing is stored", () => {
    expect(loadStoredTheme()).toBe("system");
  });
});
