import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface FileChangedEvent {
  kind: "modified" | "removed";
  path: string;
}

export interface WatcherHandle {
  stop: () => Promise<void>;
  /** Mark "we are about to write" so events for ~500ms are filtered out. */
  markSelfWrite: () => Promise<void>;
}

export interface InstallWatcherOptions {
  path: string;
  onModified: (event: FileChangedEvent) => void;
  onRemoved: (event: FileChangedEvent) => void;
}

const SELF_WRITE_WINDOW_MS = 500;

export async function installWatcher(opts: InstallWatcherOptions): Promise<WatcherHandle> {
  await invoke("watcher_start", { path: opts.path });
  let lastSelfWrite = 0;

  const unlisten: UnlistenFn = await listen<FileChangedEvent>(
    "viewer://file-changed",
    (event) => {
      // Only events about the file THIS watcher was installed for. The Rust
      // side emits with `emit_to(window_label, …)`, which reads as "just that
      // window" but isn't: a frontend `listen()` registers with
      // `EventTarget::Any` and so receives an event whatever target was
      // named. That is what #145 was, for `viewer:open-file`, and the
      // delivery path is unchanged — so without this guard every window
      // reacted to every other window's file changes: reloading a document
      // nobody had touched, prompting a reconcile over a file it did not have
      // open, or blanking itself on a deletion elsewhere.
      //
      // The question asked is "is this my *file*", not "is this my *window*",
      // and deliberately so. Two windows on one file both hold the now-stale
      // text and both must refresh, so the property the reload depends on is
      // the path, not the label. `path` is the un-canonicalized spelling the
      // frontend asked to watch, echoed back verbatim by `watcher_start`, and
      // watchers are per-window — so a window that opened the same file by a
      // different spelling (through a symlink, say) still matches the event
      // its own watcher emits. It ignores the other window's copy and reloads
      // on its own: same outcome, one event later.
      //
      // This is the guard `installFolderWatcher` already has on
      // `viewer://folder-changed`, where it is described as protecting against
      // a stale root after a swap. It does that here too: an event still in
      // flight when the window changes files can no longer reload the new
      // document because of the old one's change.
      if (event.payload.path !== opts.path) return;
      const now = Date.now();
      if (now - lastSelfWrite < SELF_WRITE_WINDOW_MS) return;
      if (event.payload.kind === "removed") opts.onRemoved(event.payload);
      else opts.onModified(event.payload);
    },
  );

  return {
    async stop() {
      unlisten();
      await invoke("watcher_stop");
    },
    async markSelfWrite() {
      lastSelfWrite = Date.now();
      await invoke("watcher_mark_self_write");
    },
  };
}
