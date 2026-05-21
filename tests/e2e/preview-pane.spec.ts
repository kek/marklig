import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
    try {
      process.kill(-viteProc.pid);
    } catch {
      // ignore — vite may have already exited
    }
  }
});

async function addTauriStubs(page: import("@playwright/test").Page, sampleMd: string): Promise<void> {
  await page.addInitScript((sample: string) => {
    let cbId = 0;
    const callbacks = new Map<number, (data: unknown) => void>();
    function transformCallback(cb: (data: unknown) => void, once = false): number {
      const id = ++cbId;
      callbacks.set(id, once ? (data: unknown) => { callbacks.delete(id); cb(data); } : cb);
      return id;
    }
    function unregisterCallback(id: number): void { callbacks.delete(id); }

    const eventListeners = new Map<number, (data: unknown) => void>();

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "path_exists") return true;
        if (cmd === "read_text_file") return sample;
        if (cmd === "take_pending_open_paths") return [];
        if (cmd === "plugin:cli|argv") return [];
        if (cmd === "plugin:dialog|open") return "/virtual/sample.md";
        if (cmd === "plugin:dialog|ask") return false;
        if (cmd === "plugin:dialog|message") return null;
        if (cmd === "watcher_start" || cmd === "watcher_stop" || cmd === "watcher_mark_self_write") return null;
        if (cmd.startsWith("plugin:window|")) return null;
        if (cmd === "plugin:menu|new") return [1, "mock-id"];
        if (cmd.startsWith("plugin:menu|")) return null;
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
        if (cmd === "read_all_recovery") return [];
        if (cmd === "clear_recovery") return null;
        if (cmd === "write_recovery") return null;
        if (cmd === "plugin:event|listen") {
          const handlerId = args?.handler as number | undefined;
          if (handlerId != null) eventListeners.set(handlerId, callbacks.get(handlerId) ?? (() => {}));
          return handlerId ?? 0;
        }
        if (cmd === "plugin:event|unlisten") {
          const handlerId = args?.id as number | undefined;
          if (handlerId != null) { eventListeners.delete(handlerId); unregisterCallback(handlerId); }
          return null;
        }
        if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") return null;
        return null;
      },
      transformCallback,
      unregisterCallback,
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
    };

    (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (id: number) => {
        eventListeners.delete(id);
        unregisterCallback(id);
      },
    };
  }, sampleMd);
}

test("Cmd-J toggles Markdown preview pane in edit mode", async ({ page }) => {
  const sample = "# Preview Test\n\nHello from the preview pane.\n\n## Section Two\n\nMore content here.\n";

  await addTauriStubs(page, sample);
  await page.goto(APP_URL);

  // Wait for the editor to load.
  await page.waitForSelector(".cm-editor");

  // Switch to edit mode by clicking the toolbar button.
  await page.locator(".viewer-toolbar-btn, .viewer-titlebar-btn").first().click();

  // Pane should be hidden by default for markdown (default is false).
  await expect(page.locator(".preview-pane")).toBeHidden();

  // Focus the editor so Cmd-J is received by CodeMirror.
  await page.locator(".cm-content").click();

  // Toggle on with Cmd-J.
  const isMac = process.platform === "darwin";
  await page.keyboard.press(isMac ? "Meta+j" : "Control+j");
  await expect(page.locator(".preview-pane")).toBeVisible();

  // Pane body should contain rendered HTML headings.
  await expect(page.locator(".preview-pane-body h1, .preview-pane-body h2"))
    .toHaveCount(2);

  // Toggle off with Cmd-J.
  await page.keyboard.press(isMac ? "Meta+j" : "Control+j");
  await expect(page.locator(".preview-pane")).toBeHidden();
});
