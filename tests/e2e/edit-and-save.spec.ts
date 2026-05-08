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

test("toggle to edit mode, type, save", async ({ page }) => {
  await page.addInitScript(() => {
    const sample = "# Initial\n\nSome text.\n";

    // ── Callback registry (mirrors the real Tauri internals) ──────────────
    let cbId = 0;
    const callbacks = new Map<number, (data: unknown) => void>();

    function transformCallback(cb: (data: unknown) => void, once = false): number {
      const id = ++cbId;
      callbacks.set(id, once ? (data: unknown) => { callbacks.delete(id); cb(data); } : cb);
      return id;
    }
    function unregisterCallback(id: number): void { callbacks.delete(id); }

    // ── Event listener registry (for plugin:event|listen) ─────────────────
    const eventListeners = new Map<number, (data: unknown) => void>();

    // ── Invoke handler ────────────────────────────────────────────────────
    async function invoke(
      cmd: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> {
      // IPC commands
      if (cmd === "read_text_file") return sample;
      if (cmd === "plugin:cli|argv") return [];
      if (cmd === "plugin:dialog|open") return "/virtual/sample.md";
      if (cmd === "plugin:dialog|ask") return false; // never prompt dialogs
      if (cmd === "plugin:dialog|message") return null;

      // File system
      if (cmd === "write_text_file") {
        (window as unknown as { __saved?: string }).__saved =
          args?.contents as string | undefined;
        return null;
      }

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

      // Event plugin: listen — register callback and return an ID
      if (cmd === "plugin:event|listen") {
        const handlerId = args?.handler as number | undefined;
        if (handlerId != null) {
          eventListeners.set(handlerId, callbacks.get(handlerId) ?? (() => {}));
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
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback,
      unregisterCallback,
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
    };

    // ── Event plugin internals ─────────────────────────────────────────────
    (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (id: number) => {
        eventListeners.delete(id);
        unregisterCallback(id);
      },
    };
  });

  await page.goto(APP_URL);

  // Reading mode: the heading should be rendered with the heading class.
  await expect(page.locator(".cm-md-heading-1")).toBeVisible();

  // Click the mode-toggle button (first toolbar button switches reading ↔ edit).
  await page.locator(".viewer-toolbar-btn").first().click();

  // In edit mode the raw "# Initial" marker should be visible in source.
  await expect(
    page.locator(".cm-line").filter({ hasText: "# Initial" }),
  ).toBeVisible();

  // Set cursor position to end of "Some text." via the CodeMirror tile reference.
  // CodeMirror stores a back-ref on each tile DOM element as `dom.cmTile`,
  // and each tile has `tile.view` pointing to the EditorView.
  await page.evaluate(() => {
    type TileEl = HTMLElement & { cmTile?: { view?: { dispatch: (tr: object) => void; state: { doc: { toString: () => string } } } } };
    // Find any cm-line element that has a cmTile with a view
    let view: { dispatch: (tr: object) => void; state: { doc: { toString: () => string } } } | undefined;
    for (const el of document.querySelectorAll(".cm-line, .cm-content")) {
      const t = (el as TileEl).cmTile?.view;
      if (t) { view = t; break; }
    }
    if (!view) return;
    const text = view.state.doc.toString();
    const idx = text.indexOf("Some text.");
    if (idx < 0) return;
    const pos = idx + "Some text.".length;
    view.dispatch({ selection: { anchor: pos, head: pos } });
  });
  await page.locator(".cm-content").focus();
  await page.keyboard.type(" extra");

  // Dirty indicator should appear.
  await expect(page.locator(".viewer-dirty-indicator")).toContainText("•");

  // Save: Cmd+S on macOS, Control+S elsewhere.
  const isMac = process.platform === "darwin";
  await page.keyboard.press(isMac ? "Meta+s" : "Control+s");

  // Dirty indicator should clear.
  await expect(page.locator(".viewer-dirty-indicator")).toHaveText("");

  // Verify the saved content includes our typed text.
  const writeContents = await page.evaluate(
    () => (window as unknown as { __saved?: string }).__saved,
  );
  expect(writeContents).toContain("Some text. extra");
});
