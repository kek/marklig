import { describe, it, expect, beforeEach, vi } from "vitest";

// The folder sidebar uses settings (which call into @tauri-apps/plugin-store)
// and the Rust list_markdown_files command. Stub both for the unit suite.
vi.mock("../../../src/shell/store", () => ({
  getValue: async () => undefined,
  setValue: async () => {},
  deleteValue: async () => {},
  listKeys: async () => [],
}));

vi.mock("../../../src/shell/files", async () => {
  const actual = await vi.importActual<typeof import("../../../src/shell/files")>(
    "../../../src/shell/files",
  );
  return {
    ...actual,
    listMarkdownFiles: vi.fn(async (_root: string) => [
      { path: "/r/a.md", relative: "a.md" },
      { path: "/r/sub/b.md", relative: "sub/b.md" },
    ]),
  };
});

import { mountFolderSidebar } from "../../../src/ui/sidebar/folder";
import { setFolderSectionOpen } from "../../../src/shell/settings";

beforeEach(() => {
  document.body.innerHTML = "";
  // Reset persisted setting so each test starts in the "open" state.
  setFolderSectionOpen(true);
});

describe("mountFolderSidebar — heading + collapsible behavior", () => {
  it("renders a single collapsible heading button showing the folder basename", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/Users/ke/projects/Märklig");

    const heading = parent.querySelector<HTMLButtonElement>(".viewer-folder-heading");
    expect(heading).not.toBeNull();
    expect(heading!.tagName).toBe("BUTTON");
    // Folder basename is the visible label; the full path lives in the tooltip.
    expect(heading!.textContent).toContain("Märklig");
    expect(heading!.title).toBe("/Users/ke/projects/Märklig");
    // ARIA: starts expanded; controls the body element.
    expect(heading!.getAttribute("aria-expanded")).toBe("true");
    const controls = heading!.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    const body = parent.querySelector<HTMLElement>(`#${controls}`);
    expect(body).not.toBeNull();
    expect(body!.hidden).toBe(false);

    // There must be no standalone "Folder" h4 anymore.
    expect(parent.querySelector(".viewer-folder h4")).toBeNull();
  });

  it("clicking the heading toggles collapsed state on body and ARIA attrs", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/r");

    const heading = parent.querySelector<HTMLButtonElement>(".viewer-folder-heading")!;
    const body = parent.querySelector<HTMLElement>(".viewer-folder-body")!;

    expect(body.hidden).toBe(false);
    expect(heading.getAttribute("aria-expanded")).toBe("true");

    heading.click();
    expect(body.hidden).toBe(true);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    // Chevron flips direction.
    expect(heading.textContent).toContain("▸");

    heading.click();
    expect(body.hidden).toBe(false);
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(heading.textContent).toContain("▾");
  });

  it("respects the persisted initial collapsed state from settings", async () => {
    setFolderSectionOpen(false);

    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/r");

    const heading = parent.querySelector<HTMLButtonElement>(".viewer-folder-heading")!;
    const body = parent.querySelector<HTMLElement>(".viewer-folder-body")!;
    expect(body.hidden).toBe(true);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
  });
});
