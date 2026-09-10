import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface DependencyChangedEvent {
  path: string;
}

export interface TypstDepWatcherHandle {
  /** Replace the watched set with `paths`. Pass `[]` to stop watching.
   *  Cheap and idempotent — an unchanged set does not reach the backend. */
  sync: (paths: string[]) => Promise<void>;
  stop: () => Promise<void>;
  /** The set currently watched. Exposed for tests. */
  watched: () => string[];
}

/**
 * Watches the files the open `.typ` document imports, and calls `onChanged`
 * when one of them changes on disk.
 *
 * This is deliberately *not* part of `installWatcher`. That watcher owns the
 * open document, where an external change means the buffer on screen is stale
 * and the reconcile flow has to decide between reloading, prompting, and
 * declaring the file orphaned. A changed *import* is a different situation:
 * the buffer is still correct and must not be touched — only the render is
 * out of date, so the only correct response is to recompile.
 *
 * The path set comes from what the compiler actually read (see
 * `CompileResult.dependencies`), so it follows imports to any depth, plus
 * `read()` and `image()` assets, without this layer parsing anything.
 */
export function installTypstDepWatcher(
  onChanged: (event: DependencyChangedEvent) => void,
): TypstDepWatcherHandle {
  let watched = new Set<string>();
  let unlisten: UnlistenFn | null = null;
  // Serialises sync() against itself. Compiles are debounced but exports can
  // force one through (`flushTypstCompile`), so two syncs can overlap; without
  // this the later-resolving one could leave `watched` describing the wrong
  // backend state.
  let queue: Promise<void> = Promise.resolve();

  const ensureListening = async (): Promise<void> => {
    if (unlisten) return;
    unlisten = await listen<DependencyChangedEvent>(
      "viewer://typst-dependency-changed",
      (event) => {
        // Same guard, and the same reason, as `installWatcher`: a frontend
        // `listen()` registers with `EventTarget::Any`, so `emit_to(label, …)`
        // on the Rust side does not actually scope delivery to one window
        // (#145). Every window receives every window's dependency events.
        // Asking "is this path in *my* set" rather than "is this my window" is
        // also what makes two windows editing the same project both recompile,
        // which is what should happen.
        if (!watched.has(event.payload.path)) return;
        onChanged(event.payload);
      },
    );
  };

  return {
    async sync(paths: string[]): Promise<void> {
      const next = new Set(paths);
      const run = queue.then(async () => {
        if (sameSet(watched, next)) return;
        if (next.size > 0) await ensureListening();
        await invoke("typst_watch_dependencies", { paths: [...next] });
        watched = next;
      });
      // Keep the chain alive even if this link rejects, so one failed sync
      // does not wedge every later one.
      queue = run.catch(() => {});
      return run;
    },
    async stop(): Promise<void> {
      const run = queue.then(async () => {
        unlisten?.();
        unlisten = null;
        watched = new Set();
        await invoke("typst_unwatch_dependencies");
      });
      queue = run.catch(() => {});
      return run;
    },
    watched(): string[] {
      return [...watched];
    },
  };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
