import { describe, it, expect, beforeEach, vi } from "vitest";

// Same stub setup as folder-new-file.test.ts — settings + Tauri-facing fs
// calls have to be mocked or the sidebar throws trying to talk to a Tauri
// context that doesn't exist in jsdom.
vi.mock("../../../src/shell/store", () => ({
  getValue: async () => undefined,
  setValue: async () => {},
  deleteValue: async () => {},
  listKeys: async () => [],
}));

const renameFileSpy = vi.fn(async (_from: string, _to: string) => {});
const trashFileSpy = vi.fn(async (_path: string) => {});

vi.mock("../../../src/shell/files", async () => {
  const actual = await vi.importActual<typeof import("../../../src/shell/files")>(
    "../../../src/shell/files",
  );
  return {
    ...actual,
    listMarkdownFiles: vi.fn(async (_root: string) => [
      { path: "/r/a.md", relative: "a.md" },
      { path: "/r/b.md", relative: "b.md" },
      { path: "/r/sub/c.md", relative: "sub/c.md" },
    ]),
    renameFile: (from: string, to: string) => renameFileSpy(from, to),
    trashFile: (path: string) => trashFileSpy(path),
    saveDoc: vi.fn(async () => {}),
  };
});

import {
  mountFolderSidebar,
  validateRenameFilename,
} from "../../../src/ui/sidebar/folder";
import { setFolderSectionOpen } from "../../../src/shell/settings";

beforeEach(() => {
  document.body.innerHTML = "";
  setFolderSectionOpen(true);
  renameFileSpy.mockClear();
  trashFileSpy.mockClear();
});

describe("validateRenameFilename", () => {
  it("rejects empty input", () => {
    expect(validateRenameFilename("", "a.md")).toEqual({ ok: false, kind: "empty" });
  });
  it("rejects whitespace-only input", () => {
    expect(validateRenameFilename("   ", "a.md")).toEqual({ ok: false, kind: "empty" });
  });
  it("rejects names containing a forward slash", () => {
    expect(validateRenameFilename("sub/b.md", "a.md")).toEqual({ ok: false, kind: "slash" });
  });
  it("rejects names containing a backslash", () => {
    expect(validateRenameFilename("sub\\b.md", "a.md")).toEqual({ ok: false, kind: "slash" });
  });
  it("returns unchanged when the trimmed name matches the current filename", () => {
    expect(validateRenameFilename("a.md", "a.md")).toEqual({ ok: true, unchanged: true });
    expect(validateRenameFilename("  a.md  ", "a.md")).toEqual({ ok: true, unchanged: true });
  });
  it("does NOT auto-append .md when the user typed a different extension", () => {
    // Unlike validateNewFilename, rename preserves the user's exact input.
    expect(validateRenameFilename("a.mdx", "a.md")).toEqual({ ok: true, filename: "a.mdx" });
  });
  it("does NOT auto-append .md when the user dropped the extension", () => {
    // Unlike validateNewFilename. The user may deliberately want an
    // extensionless file (e.g. README → README).
    expect(validateRenameFilename("README", "README.md")).toEqual({ ok: true, filename: "README" });
  });
  it("trims surrounding whitespace before validating", () => {
    expect(validateRenameFilename("  renamed.md  ", "a.md")).toEqual({ ok: true, filename: "renamed.md" });
  });
});

describe("mountFolderSidebar — rename flow", () => {
  it("right-clicking a file row shows Open / Rename… / Delete…", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onRename: async () => {},
      onDelete: async () => {},
    });
    await handle.setFolder("/r");

    const fileBtn = parent.querySelector<HTMLButtonElement>(
      ".viewer-folder-file[data-path='/r/a.md']",
    );
    expect(fileBtn).not.toBeNull();
    fileBtn!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );

    const items = document.body.querySelectorAll<HTMLButtonElement>(
      ".viewer-folder-context-menu .viewer-folder-context-menu-item",
    );
    expect(items.length).toBe(3);
    expect(items[0].textContent).toMatch(/Open/);
    expect(items[1].textContent).toMatch(/Rename/);
    expect(items[2].textContent).toMatch(/Delete/);

    // Folder rows still get just "New File…" — verify we didn't bleed the
    // file context menu over to dirs.
    document.querySelectorAll(".viewer-folder-context-menu").forEach((el) => el.remove());
    const dirRow = parent.querySelector<HTMLButtonElement>(
      ".viewer-folder-dir[data-dir='sub']",
    );
    expect(dirRow).not.toBeNull();
    dirRow!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );
    const dirItems = document.body.querySelectorAll<HTMLButtonElement>(
      ".viewer-folder-context-menu .viewer-folder-context-menu-item",
    );
    expect(dirItems.length).toBe(1);
    expect(dirItems[0].textContent).toMatch(/New File/);
  });

  it("Rename happy path: calls renameFile then onRename with (from, to)", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onRename = vi.fn();
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onRename,
    });
    await handle.setFolder("/r");

    handle.beginRename("/r/a.md");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-rename-input");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("a.md");
    input!.value = "renamed.md";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await Promise.resolve();
    await Promise.resolve();

    expect(renameFileSpy).toHaveBeenCalledTimes(1);
    expect(renameFileSpy).toHaveBeenCalledWith("/r/a.md", "/r/renamed.md");
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("/r/a.md", "/r/renamed.md");
  });

  it("Rename of a subdirectory file produces the right absolute target", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onRename = vi.fn();
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onRename,
    });
    await handle.setFolder("/r");

    handle.beginRename("/r/sub/c.md");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-rename-input")!;
    input.value = "cc.md";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await Promise.resolve();
    await Promise.resolve();

    expect(renameFileSpy).toHaveBeenCalledWith("/r/sub/c.md", "/r/sub/cc.md");
    expect(onRename).toHaveBeenCalledWith("/r/sub/c.md", "/r/sub/cc.md");
  });

  it("rejects an empty rename inline; no renameFile call", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onRename = vi.fn();
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onRename,
    });
    await handle.setFolder("/r");

    handle.beginRename("/r/a.md");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-rename-input")!;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await Promise.resolve();

    expect(renameFileSpy).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
    expect(parent.querySelector(".viewer-folder-rename-input")).not.toBeNull();
    expect(parent.querySelector(".viewer-folder-new-file-error")?.textContent).toMatch(/Enter a file name/i);
  });

  it("rejects a rename containing '/' inline", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onRename = vi.fn();
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onRename,
    });
    await handle.setFolder("/r");

    handle.beginRename("/r/a.md");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-rename-input")!;
    input.value = "sub/a.md";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await Promise.resolve();

    expect(renameFileSpy).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
    expect(parent.querySelector(".viewer-folder-new-file-error")?.textContent).toMatch(/Subfolders/i);
  });

  it("rejects a rename that collides with a sibling", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onRename = vi.fn();
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onRename,
    });
    await handle.setFolder("/r");

    handle.beginRename("/r/a.md");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-rename-input")!;
    // /r already contains b.md.
    input.value = "b.md";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await Promise.resolve();
    await Promise.resolve();

    expect(renameFileSpy).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
    expect(parent.querySelector(".viewer-folder-new-file-error")?.textContent).toMatch(/already exists/i);
  });

  it("rename to the same name is a silent no-op (no renameFile, no error)", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onRename = vi.fn();
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onRename,
    });
    await handle.setFolder("/r");

    handle.beginRename("/r/a.md");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-rename-input")!;
    input.value = "a.md";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await Promise.resolve();
    await Promise.resolve();

    expect(renameFileSpy).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
    expect(parent.querySelector(".viewer-folder-rename-input")).toBeNull();
    expect(parent.querySelector(".viewer-folder-new-file-error")).toBeNull();
  });

  it("Escape cancels the rename input without writing", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onRename = vi.fn();
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onRename,
    });
    await handle.setFolder("/r");

    handle.beginRename("/r/a.md");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-rename-input")!;
    input.value = "renamed.md";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await Promise.resolve();

    expect(renameFileSpy).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
    expect(parent.querySelector(".viewer-folder-rename-input")).toBeNull();
  });
});

describe("mountFolderSidebar — delete flow", () => {
  it("opens a confirmation modal with the file name on beginDelete", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onDelete = vi.fn();
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onDelete,
    });
    await handle.setFolder("/r");

    handle.beginDelete("/r/a.md");
    await Promise.resolve();

    const card = document.body.querySelector(".viewer-folder-delete-card");
    expect(card).not.toBeNull();
    expect(card!.textContent).toMatch(/Delete file/);
    expect(card!.textContent).toMatch(/a\.md/);

    // Cancel button is the default-focused element.
    const cancel = card!.querySelector<HTMLButtonElement>(
      ".viewer-reconcile-buttons button:not(.viewer-folder-delete-confirm)",
    );
    const confirm = card!.querySelector<HTMLButtonElement>(".viewer-folder-delete-confirm");
    expect(cancel).not.toBeNull();
    expect(confirm).not.toBeNull();
    expect(document.activeElement).toBe(cancel);
  });

  it("Cancel dismisses the modal without calling trashFile or onDelete", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onDelete = vi.fn();
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onDelete,
    });
    await handle.setFolder("/r");

    handle.beginDelete("/r/a.md");
    await Promise.resolve();

    const cancel = document.body.querySelector<HTMLButtonElement>(
      ".viewer-folder-delete-card .viewer-reconcile-buttons button:not(.viewer-folder-delete-confirm)",
    )!;
    cancel.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(trashFileSpy).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(document.body.querySelector(".viewer-folder-delete-card")).toBeNull();
  });

  it("Confirm calls trashFile then onDelete with the path", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onDelete = vi.fn();
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onDelete,
    });
    await handle.setFolder("/r");

    handle.beginDelete("/r/a.md");
    await Promise.resolve();

    const confirm = document.body.querySelector<HTMLButtonElement>(
      ".viewer-folder-delete-card .viewer-folder-delete-confirm",
    )!;
    confirm.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(trashFileSpy).toHaveBeenCalledTimes(1);
    expect(trashFileSpy).toHaveBeenCalledWith("/r/a.md");
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("/r/a.md");
  });

  it("Enter on the modal lands on Cancel (default focus) — no destructive default", async () => {
    // The body of the test is the focus assertion above plus this: a
    // keypress that "activates" the default focus must not call trashFile.
    // We simulate by clicking the default-focused element directly (jsdom
    // doesn't translate Enter→click on a button reliably).
    const parent = document.createElement("div");
    document.body.append(parent);
    const onDelete = vi.fn();
    const handle = mountFolderSidebar({
      parent,
      onActivate: () => {},
      onDelete,
    });
    await handle.setFolder("/r");

    handle.beginDelete("/r/a.md");
    await Promise.resolve();

    expect(document.activeElement).not.toBe(
      document.body.querySelector(".viewer-folder-delete-confirm"),
    );
    (document.activeElement as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(trashFileSpy).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
