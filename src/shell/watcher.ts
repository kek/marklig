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
