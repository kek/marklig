import { describe, it, expect, vi } from "vitest";

const calls: Array<{ cmd: string; args: unknown }> = [];
const responses: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    return responses[cmd];
  },
}));

import {
  writeRecovery,
  readAllRecovery,
  clearRecovery,
  startRecoveryLoop,
  resolveRecoveryAction,
} from "../../src/shell/recovery";

describe("recovery", () => {
  it("writeRecovery invokes write_recovery", async () => {
    await writeRecovery("/a.md", "content");
    const last = calls[calls.length - 1];
    expect(last.cmd).toBe("write_recovery");
    expect(last.args).toMatchObject({ originalPath: "/a.md", contents: "content" });
  });

  it("readAllRecovery maps snake_case → camelCase", async () => {
    responses["read_all_recovery"] = [{ original_path: "/a.md", contents: "x", timestamp_ms: 1 }];
    const got = await readAllRecovery();
    expect(got.length).toBe(1);
    expect(got[0].originalPath).toBe("/a.md");
    expect(got[0].timestampMs).toBe(1);
  });

  it("clearRecovery invokes clear_recovery", async () => {
    await clearRecovery("/a.md");
    const last = calls[calls.length - 1];
    expect(last.cmd).toBe("clear_recovery");
    expect(last.args).toMatchObject({ originalPath: "/a.md" });
  });

  describe("resolveRecoveryAction", () => {
    it("returns kind:'none' when the store is empty", async () => {
      const action = await resolveRecoveryAction([], async () => {
        throw new Error("readDisk should not be called when there are no entries");
      });
      expect(action).toEqual({ kind: "none" });
    });

    it("returns kind:'match' when the dump equals the on-disk file", async () => {
      const action = await resolveRecoveryAction(
        [{ originalPath: "/a.md", contents: "same", timestampMs: 1 }],
        async (path) => {
          expect(path).toBe("/a.md");
          return "same";
        },
      );
      expect(action).toEqual({ kind: "match", path: "/a.md" });
    });

    it("returns kind:'load' with the on-disk baseline when the dump differs", async () => {
      const action = await resolveRecoveryAction(
        [{ originalPath: "/a.md", contents: "newer", timestampMs: 1 }],
        async () => "older",
      );
      expect(action).toEqual({
        kind: "load",
        path: "/a.md",
        source: "newer",
        diskBaseline: "older",
      });
    });

    it("treats a missing/unreadable file as differing with an empty baseline", async () => {
      const action = await resolveRecoveryAction(
        [{ originalPath: "/gone.md", contents: "rescued", timestampMs: 1 }],
        async () => null,
      );
      expect(action).toEqual({
        kind: "load",
        path: "/gone.md",
        source: "rescued",
        diskBaseline: "",
      });
    });
  });

  it("startRecoveryLoop only writes when isDirty returns true", async () => {
    const baseline = calls.filter((c) => c.cmd === "write_recovery").length;
    let dirty = false;
    const stop = startRecoveryLoop({
      intervalMs: 10,
      isDirty: () => dirty,
      currentPath: () => "/a.md",
      currentContents: () => "live",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.cmd === "write_recovery").length).toBe(baseline);
    dirty = true;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.cmd === "write_recovery").length).toBeGreaterThan(baseline);
    stop();
  });
});
