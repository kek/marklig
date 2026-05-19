import { describe, it, expect, beforeEach, vi } from "vitest";

// Same stubs the existing folder test uses — settings + Tauri-facing fs
// calls have to be mocked or the sidebar bombs out trying to talk to a
// Tauri context that doesn't exist in jsdom.
vi.mock("../../../src/shell/store", () => ({
  getValue: async () => undefined,
  setValue: async () => {},
  deleteValue: async () => {},
  listKeys: async () => [],
}));

const saveDocSpy = vi.fn(async (_path: string, _contents: string) => {});

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
    saveDoc: (path: string, contents: string) => saveDocSpy(path, contents),
  };
});

import {
  mountFolderSidebar,
  validateNewFilename,
  joinFolderPath,
  isMarkdownFilename,
} from "../../../src/ui/sidebar/folder";
import { setFolderSectionOpen } from "../../../src/shell/settings";

beforeEach(() => {
  document.body.innerHTML = "";
  setFolderSectionOpen(true);
  saveDocSpy.mockClear();
});

describe("validateNewFilename", () => {
  it("rejects empty input", () => {
    expect(validateNewFilename("")).toEqual({ ok: false, kind: "empty" });
  });
  it("rejects whitespace-only input", () => {
    expect(validateNewFilename("   ")).toEqual({ ok: false, kind: "empty" });
  });
  it("rejects names containing a forward slash", () => {
    expect(validateNewFilename("foo/bar.md")).toEqual({ ok: false, kind: "slash" });
  });
  it("rejects names containing a backslash", () => {
    expect(validateNewFilename("foo\\bar.md")).toEqual({ ok: false, kind: "slash" });
  });
  it("appends .md when no extension is given", () => {
    expect(validateNewFilename("notes")).toEqual({ ok: true, filename: "notes.md" });
  });
  it("preserves an explicit .md extension", () => {
    expect(validateNewFilename("notes.md")).toEqual({ ok: true, filename: "notes.md" });
  });
  it("preserves alternative markdown extensions case-insensitively", () => {
    expect(validateNewFilename("notes.MARKDOWN")).toEqual({ ok: true, filename: "notes.MARKDOWN" });
    expect(validateNewFilename("notes.MDX")).toEqual({ ok: true, filename: "notes.MDX" });
    expect(validateNewFilename("notes.mdown")).toEqual({ ok: true, filename: "notes.mdown" });
  });
  it("does not second-guess an explicit unrelated extension", () => {
    expect(validateNewFilename("notes.txt")).toEqual({ ok: true, filename: "notes.txt" });
  });
  it("trims surrounding whitespace before validating", () => {
    expect(validateNewFilename("  notes.md  ")).toEqual({ ok: true, filename: "notes.md" });
  });
  it("treats a dotfile (no stem) as having no extension", () => {
    // Leading-dot name like ".gitignore" has dotIdx=0, which is not > 0,
    // so we append .md. The intended UX is "type a real name"; if the user
    // really wants .gitignore they can rename via the OS later.
    expect(validateNewFilename(".gitignore")).toEqual({ ok: true, filename: ".gitignore.md" });
  });
});

describe("isMarkdownFilename", () => {
  it("matches the four md extensions case-insensitively", () => {
    expect(isMarkdownFilename("a.md")).toBe(true);
    expect(isMarkdownFilename("a.MD")).toBe(true);
    expect(isMarkdownFilename("a.markdown")).toBe(true);
    expect(isMarkdownFilename("a.mdx")).toBe(true);
    expect(isMarkdownFilename("a.mdown")).toBe(true);
  });
  it("rejects unrelated extensions", () => {
    expect(isMarkdownFilename("a.txt")).toBe(false);
    expect(isMarkdownFilename("a")).toBe(false);
  });
});

describe("joinFolderPath", () => {
  it("joins POSIX root + filename at the root", () => {
    expect(joinFolderPath("/Users/ke/notes", "", "a.md")).toBe("/Users/ke/notes/a.md");
  });
  it("joins POSIX root + subdir + filename", () => {
    expect(joinFolderPath("/Users/ke/notes", "docs", "a.md")).toBe("/Users/ke/notes/docs/a.md");
  });
  it("strips a trailing separator from the root", () => {
    expect(joinFolderPath("/Users/ke/notes/", "", "a.md")).toBe("/Users/ke/notes/a.md");
  });
  it("normalizes a multi-segment relative subdir", () => {
    expect(joinFolderPath("/r", "docs/sub", "a.md")).toBe("/r/docs/sub/a.md");
  });
  it("uses backslashes when the root looks like Windows", () => {
    expect(joinFolderPath("C:\\Users\\ke\\notes", "docs", "a.md")).toBe("C:\\Users\\ke\\notes\\docs\\a.md");
  });
});

describe("mountFolderSidebar — new file flow", () => {
  it("renders a '+' button in the folder header", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/r");

    const btn = parent.querySelector<HTMLButtonElement>(".viewer-folder-new-file");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe("+");
    expect(btn!.getAttribute("aria-label")).toBe("New file");
  });

  it("clicking '+' opens an inline input pre-filled with untitled.md", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/r");

    parent.querySelector<HTMLButtonElement>(".viewer-folder-new-file")!.click();

    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-new-file-input");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("untitled.md");
  });

  it("Enter on a valid name writes the file and invokes onCreate with the absolute path", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onCreate = vi.fn();
    const handle = mountFolderSidebar({ parent, onActivate: () => {}, onCreate });
    await handle.setFolder("/r");

    handle.beginNewFile("");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-new-file-input")!;
    input.value = "thoughts";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    // commitNewFile is async — let microtasks flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(saveDocSpy).toHaveBeenCalledTimes(1);
    expect(saveDocSpy).toHaveBeenCalledWith("/r/thoughts.md", "");
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith("/r/thoughts.md");
  });

  it("targets a folder subtree when beginNewFile is given a relative dir", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onCreate = vi.fn();
    const handle = mountFolderSidebar({ parent, onActivate: () => {}, onCreate });
    await handle.setFolder("/r");

    handle.beginNewFile("sub");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-new-file-input")!;
    input.value = "draft";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await Promise.resolve();
    await Promise.resolve();

    expect(saveDocSpy).toHaveBeenCalledWith("/r/sub/draft.md", "");
    expect(onCreate).toHaveBeenCalledWith("/r/sub/draft.md");
  });

  it("rejects an empty name inline and does NOT call saveDoc", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onCreate = vi.fn();
    const handle = mountFolderSidebar({ parent, onActivate: () => {}, onCreate });
    await handle.setFolder("/r");

    handle.beginNewFile("");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-new-file-input")!;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await Promise.resolve();

    expect(saveDocSpy).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    // Input stays open with an error.
    expect(parent.querySelector(".viewer-folder-new-file-input")).not.toBeNull();
    expect(parent.querySelector(".viewer-folder-new-file-error")?.textContent).toMatch(/Enter a file name/i);
  });

  it("rejects a name containing '/' inline and does NOT call saveDoc", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onCreate = vi.fn();
    const handle = mountFolderSidebar({ parent, onActivate: () => {}, onCreate });
    await handle.setFolder("/r");

    handle.beginNewFile("");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-new-file-input")!;
    input.value = "sub/foo.md";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await Promise.resolve();

    expect(saveDocSpy).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    expect(parent.querySelector(".viewer-folder-new-file-error")?.textContent).toMatch(/Subfolders/i);
  });

  it("rejects a collision with an existing file in the same folder", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onCreate = vi.fn();
    const handle = mountFolderSidebar({ parent, onActivate: () => {}, onCreate });
    await handle.setFolder("/r");

    handle.beginNewFile("");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-new-file-input")!;
    // /r already contains a.md (from the listMarkdownFiles mock).
    input.value = "a.md";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await Promise.resolve();
    await Promise.resolve();

    expect(saveDocSpy).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    expect(parent.querySelector(".viewer-folder-new-file-error")?.textContent).toMatch(/already exists/i);
  });

  it("Escape cancels the input without writing", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onCreate = vi.fn();
    const handle = mountFolderSidebar({ parent, onActivate: () => {}, onCreate });
    await handle.setFolder("/r");

    handle.beginNewFile("");
    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-new-file-input")!;
    input.value = "thoughts";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await Promise.resolve();

    expect(saveDocSpy).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    expect(parent.querySelector(".viewer-folder-new-file-input")).toBeNull();
  });

  it("right-clicking a folder row shows a 'New File…' menu item that opens an input in that folder", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const handle = mountFolderSidebar({ parent, onActivate: () => {} });
    await handle.setFolder("/r");

    // The folder row for "sub" carries data-dir="sub".
    const subRow = parent.querySelector<HTMLButtonElement>(
      ".viewer-folder-dir[data-dir='sub']",
    );
    expect(subRow).not.toBeNull();
    subRow!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));

    const menuItem = document.body.querySelector<HTMLButtonElement>(
      ".viewer-folder-context-menu .viewer-folder-context-menu-item",
    );
    expect(menuItem).not.toBeNull();
    expect(menuItem!.textContent).toMatch(/New File/);
    menuItem!.click();

    const input = parent.querySelector<HTMLInputElement>(".viewer-folder-new-file-input");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("untitled.md");
  });
});
