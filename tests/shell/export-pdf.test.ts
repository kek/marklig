import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { savePdfExport } from "../../src/shell/files";

const mockedInvoke = vi.mocked(invoke);
const mockedSave = vi.mocked(save);

describe("savePdfExport", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedSave.mockReset();
  });

  it("renders to the chosen path via the native export_pdf command", async () => {
    mockedSave.mockResolvedValue("/tmp/report.pdf");
    mockedInvoke.mockResolvedValue(undefined);

    const dest = await savePdfExport("<html>doc</html>", "report.pdf");

    expect(dest).toBe("/tmp/report.pdf");
    expect(mockedInvoke).toHaveBeenCalledWith("export_pdf", {
      html: "<html>doc</html>",
      destPath: "/tmp/report.pdf",
    });
  });

  it("offers a .pdf filter and the default name in the save dialog", async () => {
    mockedSave.mockResolvedValue("/tmp/report.pdf");
    mockedInvoke.mockResolvedValue(undefined);

    await savePdfExport("<html>doc</html>", "report.pdf");

    const arg = mockedSave.mock.calls[0][0];
    expect(arg?.defaultPath).toBe("report.pdf");
    expect(arg?.filters).toEqual([{ name: "PDF", extensions: ["pdf"] }]);
  });

  it("does not render when the user cancels the dialog", async () => {
    mockedSave.mockResolvedValue(null);

    const dest = await savePdfExport("<html>doc</html>", "report.pdf");

    expect(dest).toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
