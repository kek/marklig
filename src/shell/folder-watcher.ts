import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Recursive folder watcher used to refresh the sidebar tree when files
// appear / disappear in the open project. The Rust side coalesces bursts
// (200ms debounce) and filters out events from ignored subtrees like
// node_modules and .git so a build tool churning generated files doesn't
// trigger a refresh storm.

export interface FolderChangedEvent {
  root: string;
}

export interface FolderWatcherHandle {
  stop: () => Promise<void>;
}

export interface InstallFolderWatcherOptions {
  root: string;
  onChanged: (event: FolderChangedEvent) => void;
}

export async function installFolderWatcher(
  opts: InstallFolderWatcherOptions,
): Promise<FolderWatcherHandle> {
  await invoke("folder_watcher_start", { root: opts.root });
  const unlisten: UnlistenFn = await listen<FolderChangedEvent>(
    "viewer://folder-changed",
    (event) => {
      // Best-effort guard: ignore events from a previous root if a swap
      // raced (stale event after stop() returned).
      if (event.payload.root !== opts.root) return;
      opts.onChanged(event.payload);
    },
  );
  return {
    async stop() {
      unlisten();
      try {
        await invoke("folder_watcher_stop");
      } catch {
        // Backend already gone or never started — nothing to clean up.
      }
    },
  };
}
