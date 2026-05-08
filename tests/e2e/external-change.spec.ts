import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let viteProc: ChildProcess | undefined;
const APP_URL = "http://localhost:1420";

test.beforeAll(async () => {
  viteProc = spawn("npm", ["run", "dev"], {
    cwd: resolve(__dirname, "..", ".."),
    stdio: "inherit",
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(APP_URL);
      if (r.ok) break;
    } catch {}
    await sleep(500);
  }
});

test.afterAll(async () => {
  if (viteProc?.pid) {
    try { process.kill(-viteProc.pid); } catch { /* already exited */ }
  }
});

test("clean buffer auto-reloads on external change", async ({ page }) => {
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;

    // Mutable content — tests can update this to simulate external edits.
    win.__currentContent = "# Initial\n\nSome text.\n";

    // ── Callback registry (mirrors the real Tauri internals) ──────────────
    let cbId = 0;
    const callbacks = new Map<number, (data: unknown) => void>();

    function transformCallback(cb: (data: unknown) => void, once = false): number {
      const id = ++cbId;
      callbacks.set(id, once ? (data: unknown) => { callbacks.delete(id); cb(data); } : cb);
      return id;
    }
    function unregisterCallback(id: number): void { callbacks.delete(id); }

    // ── Event listener registry ───────────────────────────────────────────
    // Maps handler ID → event name, so we can look up file-changed listeners.
    const eventListeners = new Map<number, string>();

    // Expose a way for page.evaluate to fire the viewer://file-changed event.
    // We store handler IDs keyed to event names so callers can invoke them.
    win.__fireEvent = (eventName: string, payload: unknown) => {
      for (const [handlerId, name] of eventListeners) {
        if (name === eventName) {
          const cb = callbacks.get(handlerId);
          if (cb) cb({ id: handlerId, event: eventName, payload });
        }
      }
    };

    // ── Invoke handler ────────────────────────────────────────────────────
    async function invoke(
      cmd: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> {
      // IPC commands
      if (cmd === "read_text_file") {
        return (win.__currentContent as string) ?? "# Initial\n";
      }
      if (cmd === "plugin:cli|argv") return [];
      if (cmd === "plugin:dialog|open") return "/virtual/sample.md";
      if (cmd === "plugin:dialog|ask") return false;
      if (cmd === "plugin:dialog|message") return null;

      // File system
      if (cmd === "write_text_file") return null;

      // Watcher commands — no-op
      if (
        cmd === "watcher_start" ||
        cmd === "watcher_stop" ||
        cmd === "watcher_mark_self_write"
      ) return null;

      // Window commands — no-op / return sensible defaults
      if (cmd.startsWith("plugin:window|")) return null;

      // Menu plugin — new() returns [rid, id]; everything else no-op
      if (cmd === "plugin:menu|new") return [1, "mock-id"];
      if (cmd.startsWith("plugin:menu|")) return null;

      // Store plugin — must return proper shapes to avoid destructuring errors
      if (cmd === "plugin:store|load") return 1;
      if (cmd === "plugin:store|get_store") return null;
      if (cmd === "plugin:store|get") return [null, false];
      if (cmd === "plugin:store|has") return false;
      if (cmd === "plugin:store|set") return null;
      if (cmd === "plugin:store|save") return null;
      if (cmd === "plugin:store|delete") return false;
      if (cmd === "plugin:store|clear") return null;
      if (cmd === "plugin:store|reset") return null;
      if (cmd === "plugin:store|keys") return [];
      if (cmd === "plugin:store|values") return [];
      if (cmd === "plugin:store|entries") return [];
      if (cmd === "plugin:store|length") return 0;
      if (cmd === "plugin:store|reload") return null;
      if (cmd.startsWith("plugin:store|")) return null;

      // Recovery — no-op so the recovery prompt doesn't fire
      if (cmd === "read_all_recovery") return [];
      if (cmd === "clear_recovery") return null;
      if (cmd === "write_recovery") return null;

      // Event plugin: listen — register callback and track by event name
      if (cmd === "plugin:event|listen") {
        const handlerId = args?.handler as number | undefined;
        const eventName = args?.event as string | undefined;
        if (handlerId != null && eventName != null) {
          eventListeners.set(handlerId, eventName);
        }
        return handlerId ?? 0;
      }
      // Event plugin: unlisten — clean up
      if (cmd === "plugin:event|unlisten") {
        const handlerId = args?.id as number | undefined;
        if (handlerId != null) {
          eventListeners.delete(handlerId);
          unregisterCallback(handlerId);
        }
        return null;
      }
      if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") return null;

      return null;
    }

    // ── Window metadata (needed by getCurrentWindow()) ────────────────────
    win.__TAURI_INTERNALS__ = {
      invoke,
      transformCallback,
      unregisterCallback,
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
    };

    // ── Event plugin internals ─────────────────────────────────────────────
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (id: number) => {
        eventListeners.delete(id);
        unregisterCallback(id);
      },
    };
  });

  await page.goto(APP_URL);

  // Initial render: heading should appear in reading mode.
  await expect(page.locator(".cm-md-heading-1")).toBeVisible();
  await expect(
    page.locator(".cm-line").filter({ hasText: "Initial" }),
  ).toBeVisible();

  // Simulate an external file modification:
  // 1. Update __currentContent (so the next read_text_file returns new text).
  // 2. Fire the viewer://file-changed event through the mock bridge.
  await page.evaluate(() => {
    const win = window as unknown as Record<string, unknown>;
    win.__currentContent = "# Externally Changed\n\nNew content from disk.\n";
    const fireEvent = win.__fireEvent as (
      name: string,
      payload: { kind: string; path: string },
    ) => void;
    fireEvent("viewer://file-changed", {
      kind: "modified",
      path: "/virtual/sample.md",
    });
  });

  // The reload notice should appear.
  await expect(
    page.locator(".viewer-reloaded-notice"),
  ).toBeVisible({ timeout: 4000 });

  // The new content should be reflected in the editor.
  await expect(
    page.locator(".cm-line").filter({ hasText: "Externally Changed" }),
  ).toBeVisible();
});
