import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let viteProc: ChildProcess | undefined;
const APP_URL = "http://localhost:1420";
const corpus = readFileSync(resolve(__dirname, "fixtures/visual-corpus.md"), "utf8");

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

async function setupMock(
  page: import("@playwright/test").Page,
  theme: "light" | "dark",
  source: string,
): Promise<void> {
  await page.addInitScript(
    ({ theme, source }: { theme: "light" | "dark"; source: string }) => {
      // Pre-set the theme so applyTheme(loadStoredTheme()) picks it up.
      try { localStorage.setItem("viewer.theme", theme); } catch {}

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
        if (cmd === "path_exists") return true;
        if (cmd === "read_text_file") return source;
        if (cmd === "take_pending_open_paths") return [];
        if (cmd === "plugin:cli|argv") return [];
        if (cmd === "plugin:dialog|open") return "/virtual/corpus.md";
        if (cmd === "plugin:dialog|ask") return false;
        if (cmd === "plugin:dialog|message") return null;

        // File system
        if (cmd === "write_text_file") return null;

        // Recovery — no-op so the recovery prompt doesn't fire
        if (cmd === "read_all_recovery") return [];
        if (cmd === "clear_recovery") return null;
        if (cmd === "write_recovery") return null;

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

        // Store plugin — must return proper shapes to avoid destructuring errors.
        // plugin:store|load returns a resource ID (rid); other ops depend on the rid.
        if (cmd === "plugin:store|load") return 1; // fake rid
        if (cmd === "plugin:store|get_store") return null; // not pre-loaded
        if (cmd === "plugin:store|get") return [null, false]; // [value, exists]
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
    },
    { theme, source },
  );
}

test.describe("visual regression", () => {
  test("reading mode, light theme", async ({ page }) => {
    await setupMock(page, "light", corpus);
    await page.goto(APP_URL);
    await page.locator(".cm-md-heading-1").waitFor();
    await sleep(400); // let Shiki tokens land
    await expect(page).toHaveScreenshot("reading-light.png", { maxDiffPixelRatio: 0.02 });
  });

  test("reading mode, dark theme", async ({ page }) => {
    await setupMock(page, "dark", corpus);
    await page.goto(APP_URL);
    await page.locator(".cm-md-heading-1").waitFor();
    await sleep(400); // let Shiki tokens land
    await expect(page).toHaveScreenshot("reading-dark.png", { maxDiffPixelRatio: 0.02 });
  });
});
