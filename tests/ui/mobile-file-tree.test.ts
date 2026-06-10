import { describe, it, expect } from "vitest";
import {
  buildTree,
  childrenAt,
  flattenForSearch,
  type TreeInputFile,
} from "../../src/ui/mobile-file-tree";

function f(folderIdHex: string, relpath: string): TreeInputFile {
  return { folderIdHex, relpath, syncedAtUnix: 1 };
}

const LABELS = { aaaa: "Notes", bbbb: "Work" };

describe("buildTree", () => {
  it("groups files into folder nodes labeled from the labels map", () => {
    const tree = buildTree(
      [f("aaaa", "a.md"), f("bbbb", "b.md")],
      LABELS,
    );
    expect(tree.folders.map((x) => x.label)).toEqual(["Notes", "Work"]);
    expect(tree.folders.map((x) => x.folderIdHex)).toEqual(["aaaa", "bbbb"]);
  });

  it("falls back to a truncated folder id when no label exists", () => {
    const tree = buildTree([f("0123456789abcdef", "a.md")], {});
    expect(tree.folders[0].label).toBe("01234567");
  });

  it("nests directories from the relpath and counts files", () => {
    const tree = buildTree(
      [f("aaaa", "notes/sub/c.md"), f("aaaa", "notes/a.md"), f("aaaa", "top.md")],
      LABELS,
    );
    const folder = tree.folders[0];
    expect(folder.fileCount).toBe(3);
    const notes = folder.root.dirs.get("notes")!;
    expect(notes.files.map((x) => x.relpath)).toEqual(["notes/a.md"]);
    expect(notes.dirs.get("sub")!.files.map((x) => x.relpath)).toEqual([
      "notes/sub/c.md",
    ]);
    expect(folder.root.files.map((x) => x.relpath)).toEqual(["top.md"]);
  });

  it("sorts folders by label, dirs before files, both alphabetical", () => {
    const tree = buildTree(
      [f("bbbb", "z.md"), f("bbbb", "dir/x.md"), f("aaaa", "a.md")],
      LABELS,
    );
    expect(tree.folders.map((x) => x.label)).toEqual(["Notes", "Work"]);
    const work = tree.folders[1].root;
    expect([...work.dirs.keys()]).toEqual(["dir"]);
    expect(work.files.map((x) => x.relpath)).toEqual(["z.md"]);
  });

  it("returns an empty tree for empty input", () => {
    expect(buildTree([], {}).folders).toEqual([]);
  });
});

describe("childrenAt", () => {
  const tree = buildTree([f("aaaa", "notes/sub/c.md")], LABELS);

  it("resolves the dir node at a path", () => {
    const node = childrenAt(tree, "aaaa", ["notes"]);
    expect([...node!.dirs.keys()]).toEqual(["sub"]);
  });

  it("returns null for a missing folder or path", () => {
    expect(childrenAt(tree, "zzzz", [])).toBeNull();
    expect(childrenAt(tree, "aaaa", ["nope"])).toBeNull();
  });

  it("returns the folder root for an empty segment list", () => {
    const node = childrenAt(tree, "aaaa", []);
    expect([...node!.dirs.keys()]).toEqual(["notes"]);
  });
});

describe("flattenForSearch", () => {
  it("returns one entry per file across all folders with searchKey = relpath", () => {
    const tree = buildTree(
      [f("aaaa", "notes/c.md"), f("bbbb", "b.md")],
      LABELS,
    );
    const flat = flattenForSearch(tree);
    expect(flat).toEqual([
      { folderIdHex: "aaaa", relpath: "notes/c.md", label: "Notes", searchKey: "notes/c.md" },
      { folderIdHex: "bbbb", relpath: "b.md", label: "Work", searchKey: "b.md" },
    ]);
  });

  it("returns an empty list for an empty tree", () => {
    expect(flattenForSearch(buildTree([], {}))).toEqual([]);
  });
});
