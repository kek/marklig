import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let viteProc: ChildProcess | undefined;
const APP_URL = "http://localhost:1420";

// A real 160x100 solid-blue PNG, base64-encoded. Returned by the mocked
// `read_image_base64` so the widget decodes genuine image bytes into a blob.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAUlEQVR4nO3RAQkAIBDAwO9jNcMZ0RQijIMLMNisfQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEXIrXaIhHbWNIAAAAASUVORK5CYII=";

/** Tauri-internals stub: boots the app in a plain browser, returns a doc with a
 * relative-path local image from `read_text_file`, decodes that image via
 * `read_image_base64`, and resolves the relative path against the open doc's
 * directory through the path plugin (resolve / dirname / is_absolute). */
async function installTauriStub(page: Page, sample: string, png: string): Promise<void> {
  await page.addInitScript(([sampleArg, pngArg]: [string, string]) => {
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
        if (cmd === "read_text_file") return sampleArg;
        if (cmd === "read_image_base64") {
          if (String(args?.path ?? "").includes("missing")) throw new Error("io error: not found");
          return pngArg;
        }
        if (cmd === "take_pending_open_paths") return [];
        if (cmd === "plugin:cli|argv") return [];
        if (cmd === "plugin:dialog|open") return "/virtual/doc.md";
        if (cmd === "plugin:dialog|ask") return false;
        if (cmd === "plugin:dialog|message") return null;
        // Path plugin — resolve the relative image against /virtual/doc.md.
        if (cmd === "plugin:path|is_absolute") return String(args?.path ?? "").startsWith("/");
        if (cmd === "plugin:path|dirname") {
          const p = String(args?.path ?? "");
          return p.slice(0, p.lastIndexOf("/")) || "/";
        }
        if (cmd === "plugin:path|resolve") {
          const parts = (args?.paths as string[] | undefined) ?? [];
          return parts.join("/").replace(/\/+/g, "/");
        }
        if (cmd === "watcher_start" || cmd === "watcher_stop" || cmd === "watcher_mark_self_write") return null;
        if (cmd.startsWith("plugin:window|")) return null;
        if (cmd === "plugin:menu|new") return [1, "mock-id"];
        if (cmd.startsWith("plugin:menu|")) return null;
        if (cmd === "plugin:store|load") return 1;
        if (cmd === "plugin:store|get") return [null, false];
        if (cmd === "plugin:store|has") return false;
        if (cmd.startsWith("plugin:store|")) return null;
        if (cmd === "read_all_recovery") return [];
        if (cmd === "clear_recovery" || cmd === "write_recovery") return null;
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
      unregisterListener: (id: number) => { eventListeners.delete(id); unregisterCallback(id); },
    };
  }, [sample, png] as [string, string]);
}

test.beforeAll(async () => {
  viteProc = spawn("npm", ["run", "dev"], {
    cwd: resolve(__dirname, "..", ".."),
    stdio: "inherit",
    detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(APP_URL); if (r.ok) break; } catch {}
    await sleep(500);
  }
});

test.afterAll(async () => {
  if (viteProc?.pid) { try { process.kill(-viteProc.pid); } catch {} }
});

test("renders a relative-path local image as a blob in reading mode", async ({ page }) => {
  const sample = "# Future architecture\n\n![Future architecture diagram](docs/future-architecture.png)\n";
  await installTauriStub(page, sample, PNG_B64);
  await page.goto(APP_URL);

  const img = page.locator("img.cm-md-reading-image");
  await expect(img).toBeVisible({ timeout: 10_000 });

  // The src must be an object URL (proves it went through the disk-read cache,
  // not the raw relative path that 404s against tauri://localhost).
  await expect(img).toHaveAttribute("src", /^blob:/);

  // And the bytes actually decoded into a displayable image.
  const natural = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  expect(natural).toBe(160);
});

test("shows a broken-image placeholder when the local file can't be read", async ({ page }) => {
  const sample = "# Doc\n\n![Gone](docs/missing.png)\n";
  await installTauriStub(page, sample, PNG_B64);
  await page.goto(APP_URL);

  // No <img> should appear; the disk read fails → broken placeholder.
  const broken = page.locator(".cm-md-reading-image-broken");
  await expect(broken).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("img.cm-md-reading-image")).toHaveCount(0);
});
