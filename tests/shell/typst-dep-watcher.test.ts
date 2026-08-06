import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...(args as [])),
}));

const listeners: Array<{ event: string; handler: (e: unknown) => void }> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: unknown) => void) => {
    listeners.push({ event, handler });
    return () => {
      const i = listeners.findIndex((l) => l.handler === handler);
      if (i >= 0) listeners.splice(i, 1);
    };
  }),
}));

import { installTypstDepWatcher } from "../../src/shell/typst-dep-watcher";

/** Deliver the way Tauri v2 actually does: to every registered listener,
 *  whatever window `emit_to` named — a frontend `listen()` registers with
 *  `EventTarget::Any` (#145). Two installs here stand in for two windows. */
function emitToEveryWindow(path: string): void {
  for (const l of listeners) {
    if (l.event === "viewer://typst-dependency-changed") l.handler({ payload: { path } });
  }
}

beforeEach(() => {
  listeners.length = 0;
  invoke.mockClear();
});

describe("typst dependency watcher", () => {
  it("recompiles when a watched import changes", async () => {
    const onChanged = vi.fn();
    const w = installTypstDepWatcher(onChanged);
    await w.sync(["/cv/template.typ", "/cv/strings.typ"]);

    emitToEveryWindow("/cv/template.typ");

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith({ path: "/cv/template.typ" });
  });

  it("ignores a dependency belonging to another window's document", async () => {
    const mine = vi.fn();
    const theirs = vi.fn();
    const a = installTypstDepWatcher(mine);
    const b = installTypstDepWatcher(theirs);
    await a.sync(["/cv/template.typ"]);
    await b.sync(["/notes/other.typ"]);

    emitToEveryWindow("/notes/other.typ");

    expect(mine).not.toHaveBeenCalled();
    expect(theirs).toHaveBeenCalledTimes(1);
  });

  it("two windows on the same project both recompile", async () => {
    const a = vi.fn();
    const b = vi.fn();
    await installTypstDepWatcher(a).sync(["/cv/template.typ"]);
    await installTypstDepWatcher(b).sync(["/cv/template.typ"]);

    emitToEveryWindow("/cv/template.typ");

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  // Compiles are debounced at 300ms while typing, and each one calls sync().
  // Re-establishing kernel watches that often would be pure waste, so an
  // unchanged set must not reach the backend at all.
  it("does not re-invoke for an unchanged set, regardless of order", async () => {
    const w = installTypstDepWatcher(vi.fn());
    await w.sync(["/cv/a.typ", "/cv/b.typ"]);
    expect(invoke).toHaveBeenCalledTimes(1);

    await w.sync(["/cv/b.typ", "/cv/a.typ"]);
    await w.sync(["/cv/a.typ", "/cv/b.typ"]);
    expect(invoke).toHaveBeenCalledTimes(1);

    await w.sync(["/cv/a.typ"]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("stops watching after the set is emptied", async () => {
    const onChanged = vi.fn();
    const w = installTypstDepWatcher(onChanged);
    await w.sync(["/cv/template.typ"]);
    await w.sync([]);

    emitToEveryWindow("/cv/template.typ");

    expect(onChanged).not.toHaveBeenCalled();
    expect(w.watched()).toEqual([]);
  });

  it("stop() unsubscribes and clears the set", async () => {
    const onChanged = vi.fn();
    const w = installTypstDepWatcher(onChanged);
    await w.sync(["/cv/template.typ"]);
    await w.stop();

    emitToEveryWindow("/cv/template.typ");

    expect(onChanged).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("typst_unwatch_dependencies");
  });

  // A rejected sync must not wedge the chain: the next one still has to run,
  // or one transient IPC failure would silently stop all future watching.
  it("survives a failed sync", async () => {
    const w = installTypstDepWatcher(vi.fn());
    invoke.mockRejectedValueOnce(new Error("ipc down"));
    await expect(w.sync(["/cv/a.typ"])).rejects.toThrow("ipc down");
    expect(w.watched()).toEqual([]);

    await w.sync(["/cv/a.typ"]);
    expect(w.watched()).toEqual(["/cv/a.typ"]);
  });
});
