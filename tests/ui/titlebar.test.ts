import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  mountTitlebar,
  isMacPlatform,
  applyPlatformClass,
  buildWindowTitle,
  setWindowTitle,
} from "../../src/ui/titlebar";

let host: HTMLElement;
let dom: JSDOM;
let originalNavigator: Navigator | undefined;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="host"></div>');
  globalThis.document = dom.window.document;
  // Capture the JSDOM-provided navigator so we can swap in stubs per test
  // and restore it cleanly.
  originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  host = dom.window.document.getElementById("host")!;
});

afterEach(() => {
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  }
});

function makeView(): EditorView {
  return new EditorView({
    state: EditorState.create({ doc: "" }),
    parent: host,
  });
}

function setNavigator(stub: Partial<Navigator>): void {
  Object.defineProperty(globalThis, "navigator", {
    value: stub,
    configurable: true,
    writable: true,
  });
}

describe("isMacPlatform", () => {
  it("returns true when navigator.platform reports macOS", () => {
    setNavigator({ platform: "MacIntel", userAgent: "irrelevant" });
    expect(isMacPlatform()).toBe(true);
  });

  it("returns true when only userAgent reports macOS", () => {
    setNavigator({
      platform: "",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
    });
    expect(isMacPlatform()).toBe(true);
  });

  it("returns false for Windows", () => {
    setNavigator({ platform: "Win32", userAgent: "Windows NT 10.0" });
    expect(isMacPlatform()).toBe(false);
  });

  it("returns false for Linux", () => {
    setNavigator({ platform: "Linux x86_64", userAgent: "X11; Linux" });
    expect(isMacPlatform()).toBe(false);
  });
});

describe("applyPlatformClass", () => {
  it("adds .platform-macos to <html> when running on macOS", () => {
    setNavigator({ platform: "MacIntel", userAgent: "" });
    applyPlatformClass();
    expect(document.documentElement.classList.contains("platform-macos")).toBe(true);
  });

  it("removes .platform-macos when not on macOS", () => {
    document.documentElement.classList.add("platform-macos");
    setNavigator({ platform: "Win32", userAgent: "" });
    applyPlatformClass();
    expect(document.documentElement.classList.contains("platform-macos")).toBe(false);
  });
});

describe("buildWindowTitle", () => {
  it("shows just the file name when no project folder is open", () => {
    expect(buildWindowTitle("/Users/foo/notes/intro.md", false, null)).toBe(
      "intro.md",
    );
    expect(buildWindowTitle("/Users/foo/notes/intro.md", false)).toBe(
      "intro.md",
    );
  });

  it("appends the project folder basename when a folder is open", () => {
    expect(
      buildWindowTitle("/repos/viewer/README.md", false, "/repos/viewer"),
    ).toBe("README.md — viewer");
    expect(
      buildWindowTitle(
        "/repos/marklig-mobile/README.md",
        false,
        "/repos/marklig-mobile",
      ),
    ).toBe("README.md — marklig-mobile");
  });

  it("uses the project basename, not the full path", () => {
    expect(
      buildWindowTitle("/a/b/c/notes.md", false, "/a/b/c"),
    ).toBe("notes.md — c");
  });

  it("handles Windows-style backslash separators", () => {
    expect(
      buildWindowTitle("C:\\repos\\viewer\\README.md", false, "C:\\repos\\viewer"),
    ).toBe("README.md — viewer");
  });

  it("prefixes the dirty bullet, with and without a project", () => {
    expect(buildWindowTitle("/x/intro.md", true, null)).toBe("• intro.md");
    expect(buildWindowTitle("/repos/viewer/README.md", true, "/repos/viewer")).toBe(
      "• README.md — viewer",
    );
  });

  it("shows the folder basename when only a folder is open, no document (#159)", () => {
    expect(buildWindowTitle(null, false, "/path/to/my-notes")).toBe("my-notes");
    expect(buildWindowTitle(null, true, "/path/to/my-notes")).toBe(
      "• my-notes",
    );
    expect(buildWindowTitle(null, false, "/repos/viewer")).toBe("viewer");
  });

  it("falls back to the app name when neither a file nor a folder is open", () => {
    expect(buildWindowTitle(null, false, null)).toBe("Märklig");
    expect(buildWindowTitle(null, true, null)).toBe("• Märklig");
    expect(buildWindowTitle(null, false)).toBe("Märklig");
  });

  it("does not repeat the name when the file basename equals the project", () => {
    expect(buildWindowTitle("/repos/viewer", false, "/repos/viewer")).toBe(
      "viewer",
    );
  });
});

describe("setWindowTitle", () => {
  it("writes the composed title to document.title when the Tauri API is absent", async () => {
    await setWindowTitle("/repos/viewer/README.md", false, "/repos/viewer");
    expect(document.title).toBe("README.md — viewer");

    await setWindowTitle("/repos/viewer/README.md", true, "/repos/viewer");
    expect(document.title).toBe("• README.md — viewer");

    await setWindowTitle("/x/intro.md", false, null);
    expect(document.title).toBe("intro.md");
  });
});

describe("mountTitlebar", () => {
  it("renders Edit and TOC toggles as inline-SVG icon buttons", () => {
    const view = makeView();
    mountTitlebar(host, {
      view,
      modeExtensions: {
        reading: { decorations: [], keymap: [] },
        edit: { decorations: [], keymap: [] },
      },
      initialMode: "reading",
    });

    const bar = host.querySelector(".viewer-titlebar");
    expect(bar).not.toBeNull();
    const buttons = host.querySelectorAll<HTMLButtonElement>(".viewer-titlebar-btn");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    const [editBtn, tocBtn] = [buttons[0], buttons[1]];

    expect(editBtn.querySelector("svg")).not.toBeNull();
    expect(tocBtn.querySelector("svg")).not.toBeNull();

    expect(editBtn.getAttribute("aria-label")).toBeTruthy();
    expect(editBtn.getAttribute("title")).toBeTruthy();
    expect(tocBtn.getAttribute("aria-label")).toBeTruthy();
    expect(tocBtn.getAttribute("title")).toBeTruthy();
  });

  it("reflects edit mode and sidebar visibility via aria-pressed", () => {
    const view = makeView();
    const handle = mountTitlebar(host, {
      view,
      modeExtensions: {
        reading: { decorations: [], keymap: [] },
        edit: { decorations: [], keymap: [] },
      },
      initialMode: "reading",
      initialSidebarVisible: false,
    });
    const buttons = host.querySelectorAll<HTMLButtonElement>(".viewer-titlebar-btn");
    const [editBtn, tocBtn] = [buttons[0], buttons[1]];

    expect(editBtn.getAttribute("aria-pressed")).toBe("false");
    expect(tocBtn.getAttribute("aria-pressed")).toBe("false");

    handle.setMode("edit");
    expect(editBtn.getAttribute("aria-pressed")).toBe("true");

    handle.setSidebarVisible(true);
    expect(tocBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders the file name with a dirty indicator", () => {
    const view = makeView();
    const handle = mountTitlebar(host, {
      view,
      modeExtensions: {
        reading: { decorations: [], keymap: [] },
        edit: { decorations: [], keymap: [] },
      },
      initialMode: "reading",
    });
    handle.setPath("/Users/foo/notes/intro.md");
    const path = host.querySelector(".viewer-titlebar-path") as HTMLElement;
    expect(path.textContent).toBe("intro.md");
    expect(path.title).toBe("/Users/foo/notes/intro.md");

    const dirty = host.querySelector(".viewer-titlebar-dirty") as HTMLElement;
    expect(dirty.textContent).toBe("");
    handle.setDirty(true);
    expect(dirty.textContent).toBe("•");
    handle.setDirty(false);
    expect(dirty.textContent).toBe("");
  });

  it("appends the project folder name to the visible title when a folder is open (#98)", () => {
    // Regression: on macOS the OS window title is hidden (hiddenTitle: true),
    // so the project name must appear in this *visible* custom-titlebar readout,
    // not only via setWindowTitle. setPath takes the project folder and renders
    // `<file> — <project>`.
    const view = makeView();
    const handle = mountTitlebar(host, {
      view,
      modeExtensions: {
        reading: { decorations: [], keymap: [] },
        edit: { decorations: [], keymap: [] },
      },
      initialMode: "reading",
    });
    const path = host.querySelector(".viewer-titlebar-path") as HTMLElement;

    handle.setPath("/repos/viewer/README.md", "/repos/viewer");
    expect(path.textContent).toBe("README.md — viewer");
    // Full path still preserved in the title attribute for hover/tooling.
    expect(path.title).toBe("/repos/viewer/README.md");

    // No folder → file name only (unchanged behavior).
    handle.setPath("/repos/viewer/README.md", null);
    expect(path.textContent).toBe("README.md");

    // Clearing the path clears the readout.
    handle.setPath(null, "/repos/viewer");
    expect(path.textContent).toBe("");
  });

  it("renders word/char/time stats", () => {
    const view = makeView();
    const handle = mountTitlebar(host, {
      view,
      modeExtensions: {
        reading: { decorations: [], keymap: [] },
        edit: { decorations: [], keymap: [] },
      },
      initialMode: "reading",
    });
    handle.setStats({ words: 1234, chars: 5678, readingMinutes: 7 });
    const stats = host.querySelector(".viewer-titlebar-stats") as HTMLElement;
    expect(stats.textContent).toContain("1,234");
    expect(stats.textContent).toContain("5,678");
    expect(stats.textContent).toContain("7 min");
  });

  it("reserves traffic-light space via a left spacer", () => {
    const view = makeView();
    mountTitlebar(host, {
      view,
      modeExtensions: {
        reading: { decorations: [], keymap: [] },
        edit: { decorations: [], keymap: [] },
      },
      initialMode: "reading",
    });
    const spacer = host.querySelector(".viewer-titlebar-spacer-left");
    expect(spacer).not.toBeNull();
  });
});
