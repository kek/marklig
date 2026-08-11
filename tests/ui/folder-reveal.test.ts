import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { mountFolderSidebar } from "../../src/ui/sidebar/folder";

const TREE = [
  { path: "/proj/readme.md", relative: "readme.md" },
  { path: "/proj/docs/api.md", relative: "docs/api.md" },
  { path: "/proj/docs/deep/x.md", relative: "docs/deep/x.md" },
];

describe("revealDirectory", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) =>
      cmd === "list_documents" ? Promise.resolve(TREE) : Promise.resolve(null),
    );
    document.body.innerHTML = "";
  });

  it("expands the requested directory without changing the root", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/proj");

    handle.revealDirectory("/proj/docs");

    const docs = parent.querySelector('[data-dir="docs"]');
    expect(docs?.getAttribute("aria-expanded")).toBe("true");
    // Root is untouched — this is a reveal, not a re-root. Proven by the
    // sibling file row still being rendered: it would vanish if setFolder
    // had been called again with "/proj/docs" as the new root.
    expect(parent.querySelector('[data-path="/proj/readme.md"]')).not.toBeNull();
  });

  it("expands every ancestor on the way down", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/proj");

    handle.revealDirectory("/proj/docs/deep");

    expect(parent.querySelector('[data-dir="docs"]')?.getAttribute("aria-expanded"))
      .toBe("true");
    expect(parent.querySelector('[data-dir="docs/deep"]')?.getAttribute("aria-expanded"))
      .toBe("true");
  });

  it("ignores a directory outside the current root", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/proj");

    expect(() => handle.revealDirectory("/elsewhere/docs")).not.toThrow();
    expect(parent.querySelector('[data-dir="docs"]')?.getAttribute("aria-expanded"))
      .not.toBe("true");
  });
});
