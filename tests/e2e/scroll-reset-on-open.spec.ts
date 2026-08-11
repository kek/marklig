import { test, expect } from "@playwright/test";
import { setTimeout as sleep } from "node:timers/promises";

const APP_URL = "http://localhost:1420";

/** Build an addInitScript callback that installs a virtual two-file folder.
 * `seeded` becomes the persisted `filePositions` map the store plugin returns,
 * so a test can pre-seed a saved scroll position for the regression case.
 * Note: the body runs in the page, so it must be self-contained — `seeded` is
 * passed through page.addInitScript's argument channel. */
function installFolder() {
  return (seeded: Record<string, unknown>) => {
    const win = window as unknown as Record<string, unknown>;

    const folderRoot = "/virtual/notes";
    const longBody = (label: string) => Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of file ${label}, with enough text to require scrolling.`).join("\n\n");
    const fileContents = new Map<string, string>([
      ["/virtual/notes/a.md", `# File A\n\n${longBody("A")}\n`],
      // B is tall too so a seeded scrollTop is reachable, not clamped to 0.
      ["/virtual/notes/b.md", `# File B\n\n${longBody("B")}\n`],
    ]);
    const folderFiles = [
      { path: "/virtual/notes/a.md", relative: "a.md" },
      { path: "/virtual/notes/b.md", relative: "b.md" },
    ];

    // Persisted store state. filePositions is seeded by the test.
    const store: Record<string, unknown> = {
      currentFolder: folderRoot,
      filePositions: seeded,
    };

    let cbId = 0;
    const callbacks = new Map<number, (data: unknown) => void>();
    function transformCallback(cb: (data: unknown) => void, once = false): number {
      const id = ++cbId;
      callbacks.set(id, once ? (data: unknown) => { callbacks.delete(id); cb(data); } : cb);
      return id;
    }
    function unregisterCallback(id: number): void { callbacks.delete(id); }
    const eventListeners = new Map<number, string>();

    async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      if (cmd === "read_text_file") return fileContents.get(args?.path as string) ?? "";
      if (cmd === "path_exists") return fileContents.has(args?.path as string);
      // canonicalize_path is the key file-positions uses; identity is fine here.
      if (cmd === "canonicalize_path") return args?.path as string;
      if (cmd === "plugin:cli|argv") return [];
      // Bootstrap falls through to open dialog → load file A first.
      if (cmd === "plugin:dialog|open") return "/virtual/notes/a.md";
      if (cmd === "plugin:dialog|ask") return false;
      if (cmd === "plugin:dialog|message") return null;

      if (cmd === "list_documents") return folderFiles.map((f) => ({ ...f }));
      if (cmd === "resolve_folder_root") return folderRoot;
      if (cmd === "is_directory") return false;
      if (cmd === "take_pending_open_paths") return [];
      if (cmd === "recents_os_get") return [];
      if (cmd === "recents_os_add") return null;
      if (cmd === "recents_os_clear") return null;
      if (cmd === "list_pairings") return [];
      if (cmd === "list_folder_sync_configs") return [];

      if (
        cmd === "watcher_start" || cmd === "watcher_stop" ||
        cmd === "watcher_mark_self_write" ||
        cmd === "folder_watcher_start" || cmd === "folder_watcher_stop"
      ) return null;

      if (cmd.startsWith("plugin:window|")) return null;
      if (cmd === "plugin:menu|new") return [1, "mock-id"];
      if (cmd.startsWith("plugin:menu|")) return null;

      // Store plugin backed by the in-memory `store` object.
      if (cmd === "plugin:store|load") return 1;
      if (cmd === "plugin:store|get_store") return null;
      if (cmd === "plugin:store|get") {
        const key = args?.key as string | undefined;
        if (key != null && key in store) return [store[key], true];
        return [null, false];
      }
      if (cmd === "plugin:store|has") {
        const key = args?.key as string | undefined;
        return key != null && key in store;
      }
      if (cmd === "plugin:store|set") {
        const key = args?.key as string | undefined;
        if (key != null) store[key] = args?.value;
        return null;
      }
      if (cmd === "plugin:store|delete") {
        const key = args?.key as string | undefined;
        if (key != null && key in store) { delete store[key]; return true; }
        return false;
      }
      if (cmd === "plugin:store|keys") return Object.keys(store);
      if (cmd === "plugin:store|values") return Object.values(store);
      if (cmd === "plugin:store|entries") return Object.entries(store);
      if (cmd === "plugin:store|length") return Object.keys(store).length;
      if (cmd.startsWith("plugin:store|")) return null;

      if (cmd === "read_all_recovery") return [];
      if (cmd === "clear_recovery") return null;
      if (cmd === "write_recovery") return null;

      if (cmd === "plugin:event|listen") {
        const handlerId = args?.handler as number | undefined;
        const eventName = args?.event as string | undefined;
        if (handlerId != null && eventName != null) eventListeners.set(handlerId, eventName);
        return handlerId ?? 0;
      }
      if (cmd === "plugin:event|unlisten") {
        const handlerId = args?.id as number | undefined;
        if (handlerId != null) { eventListeners.delete(handlerId); unregisterCallback(handlerId); }
        return null;
      }
      if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") return null;

      return null;
    }

    win.__TAURI_INTERNALS__ = {
      invoke,
      transformCallback,
      unregisterCallback,
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
    };
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (id: number) => { eventListeners.delete(id); unregisterCallback(id); },
    };
  };
}

async function scrollTopOf(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => document.querySelector(".cm-scroller")!.scrollTop);
}

test("opening a file with no saved position resets scroll to the top (issue #146)", async ({ page }) => {
  await page.addInitScript(installFolder(), {});

  await page.goto(`${APP_URL}/?file=${encodeURIComponent("/virtual/notes/a.md")}`);
  await expect(page.locator(".cm-md-heading-1")).toBeVisible({ timeout: 5000 });

  // Scroll file A down. Wait until the restore watchdog (~1.5s) has stopped
  // re-pinning scrollTop, otherwise it would fight our manual scroll.
  await sleep(1800);
  await page.locator(".cm-scroller").evaluate((el) => { el.scrollTop = 400; });
  await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(100);

  // Open file B (no saved position) from the sidebar.
  await page.locator(".viewer-folder-file").filter({ hasText: "b.md" }).click();

  // B must start at the top — the previous file's scrollTop must not bleed in.
  await expect.poll(() => scrollTopOf(page), { timeout: 4000 }).toBe(0);
});

test("opening a file WITH a saved position restores to it", async ({ page }) => {
  // Seed a saved position for file B at scrollTop 250.
  await page.addInitScript(installFolder(), {
    "/virtual/notes/b.md": { scrollTop: 250, line: 1, col: 0, ts: 1 },
  });

  await page.goto(`${APP_URL}/?file=${encodeURIComponent("/virtual/notes/a.md")}`);
  await expect(page.locator(".cm-md-heading-1")).toBeVisible({ timeout: 5000 });
  await sleep(1800);

  // Open file B, which has a seeded saved position (scrollTop 250) and is tall
  // enough that 250 is reachable rather than clamped to 0.
  await page.locator(".viewer-folder-file").filter({ hasText: "b.md" }).click();
  await expect(page.locator(".cm-md-heading-1")).toContainText("File B");

  // The saved position must be restored, not reset to the top.
  await expect.poll(() => scrollTopOf(page), { timeout: 4000 }).toBeGreaterThan(100);
});
