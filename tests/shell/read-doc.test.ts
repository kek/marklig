import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { readDoc } from "../../src/shell/files";

const mockedInvoke = vi.mocked(invoke);

describe("readDoc", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("returns the source for an existing file", async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return true;
      if (cmd === "read_text_file") return "# hello\n";
      throw new Error(`unexpected command: ${cmd}`);
    });

    const doc = await readDoc("/tmp/exists.md");
    expect(doc.path).toBe("/tmp/exists.md");
    expect(doc.source).toBe("# hello\n");
    expect(doc.isNew).toBeUndefined();
  });

  it("returns an empty buffer with isNew=true when the path doesn't exist", async () => {
    // `md newfile.md` lands here. read_text_file must not be invoked — that
    // would surface ENOENT and we'd lose the new-file affordance.
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === "path_exists") return false;
      throw new Error(`unexpected command: ${cmd}`);
    });

    const doc = await readDoc("/tmp/brand-new.md");
    expect(doc).toEqual({
      path: "/tmp/brand-new.md",
      source: "",
      isNew: true,
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("read_text_file", expect.anything());
  });
});
