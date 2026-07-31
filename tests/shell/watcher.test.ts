import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
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

import { installWatcher, type FileChangedEvent } from "../../src/shell/watcher";

/** Deliver an event the way Tauri v2 does: to every registered listener,
 *  whatever window `emit_to` named. A frontend `listen()` registers with
 *  `EventTarget::Any`, so a target label does not scope delivery (this is
 *  what #145 established for `viewer:open-file`). Two `installWatcher` calls
 *  here therefore stand in for two windows. */
function emitToEveryWindow(payload: FileChangedEvent): void {
  for (const l of listeners) {
    if (l.event === "viewer://file-changed") l.handler({ payload });
  }
}

beforeEach(() => {
  listeners.length = 0;
  vi.clearAllMocks();
});

describe("installWatcher only reacts to its own file", () => {
  it("ignores a change to a file another window is watching", async () => {
    const alpha = { onModified: vi.fn(), onRemoved: vi.fn() };
    const beta = { onModified: vi.fn(), onRemoved: vi.fn() };
    await installWatcher({ path: "/docs/alpha.md", ...alpha });
    await installWatcher({ path: "/docs/beta.md", ...beta });

    emitToEveryWindow({ kind: "modified", path: "/docs/alpha.md" });

    expect(alpha.onModified).toHaveBeenCalledTimes(1);
    // Beta does not have alpha.md open. Before the path guard it reloaded
    // beta.md here — and if it was dirty, prompted the user to reconcile
    // unsaved work against a change to a file it wasn't showing.
    expect(beta.onModified).not.toHaveBeenCalled();
  });

  it("ignores a removal of a file another window is watching", async () => {
    const alpha = { onModified: vi.fn(), onRemoved: vi.fn() };
    const beta = { onModified: vi.fn(), onRemoved: vi.fn() };
    await installWatcher({ path: "/docs/alpha.md", ...alpha });
    await installWatcher({ path: "/docs/beta.md", ...beta });

    emitToEveryWindow({ kind: "removed", path: "/docs/alpha.md" });

    expect(alpha.onRemoved).toHaveBeenCalledTimes(1);
    // The worse half of the bug: `onRemoved` drops the window's path and
    // clears its title, so a deletion in one window disowned the document in
    // every other one.
    expect(beta.onRemoved).not.toHaveBeenCalled();
  });

  it("still notifies every window that has the changed file open", async () => {
    // Two windows on one file is legitimate and both are showing stale text,
    // so the guard must not silence the second one. Each window has its own
    // backend watcher, so the change arrives as two events — one per watcher
    // — and both windows accept both.
    const first = { onModified: vi.fn(), onRemoved: vi.fn() };
    const second = { onModified: vi.fn(), onRemoved: vi.fn() };
    await installWatcher({ path: "/docs/shared.md", ...first });
    await installWatcher({ path: "/docs/shared.md", ...second });

    emitToEveryWindow({ kind: "modified", path: "/docs/shared.md" });

    expect(first.onModified).toHaveBeenCalledTimes(1);
    expect(second.onModified).toHaveBeenCalledTimes(1);
  });

  it("matches the spelling it was asked to watch, not a canonical one", async () => {
    // `watcher_start` echoes back the path as handed to it, precisely so the
    // frontend can compare against what it asked for. A window watching a
    // symlinked spelling must not be moved by an event carrying the resolved
    // one — that event belongs to whichever window asked for *that* spelling,
    // and this window's own watcher will report the change under its own.
    const linked = { onModified: vi.fn(), onRemoved: vi.fn() };
    await installWatcher({ path: "/tmp/link/file.md", ...linked });

    emitToEveryWindow({ kind: "modified", path: "/private/tmp/real/file.md" });
    expect(linked.onModified).not.toHaveBeenCalled();

    emitToEveryWindow({ kind: "modified", path: "/tmp/link/file.md" });
    expect(linked.onModified).toHaveBeenCalledTimes(1);
  });

  it("drops an event that arrives from the watcher it just replaced", async () => {
    // Same guard, second benefit: an event queued for the old document before
    // `stop()` took effect must not reload the new one.
    const opts = { onModified: vi.fn(), onRemoved: vi.fn() };
    const handle = await installWatcher({ path: "/docs/old.md", ...opts });
    await handle.stop();
    await installWatcher({ path: "/docs/new.md", ...opts });

    emitToEveryWindow({ kind: "modified", path: "/docs/old.md" });

    expect(opts.onModified).not.toHaveBeenCalled();
  });

  it("still filters out our own writes for the file we do watch", async () => {
    // The self-write window is unchanged by the path guard; pin it so a later
    // reshuffle of the two checks can't drop it.
    const opts = { onModified: vi.fn(), onRemoved: vi.fn() };
    const handle = await installWatcher({ path: "/docs/alpha.md", ...opts });
    await handle.markSelfWrite();

    emitToEveryWindow({ kind: "modified", path: "/docs/alpha.md" });

    expect(opts.onModified).not.toHaveBeenCalled();
  });
});
