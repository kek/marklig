// E2E for the sidebar file context menu's Rename… and Delete… items
// (issue #108). Same Tauri-stub harness as new-file-in-sidebar.spec.ts —
// in-memory file table that the stubs read and mutate.

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

async function installFolderStub(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;

    interface FileEntry { path: string; relative: string }
    const folderRoot = "/virtual/notes";
    const folderFiles: FileEntry[] = [
      { path: "/virtual/notes/sample.md", relative: "sample.md" },
      { path: "/virtual/notes/other.md", relative: "other.md" },
    ];
    const fileContents = new Map<string, string>([
      ["/virtual/notes/sample.md", "# Sample\n\nExisting content.\n"],
      ["/virtual/notes/other.md", "# Other\n"],
    ]);
    win.__folderFiles = folderFiles;
    win.__fileContents = fileContents;

    let cbId = 0;
    const callbacks = new Map<number, (data: unknown) => void>();
    function transformCallback(cb: (data: unknown) => void, once = false): number {
      const id = ++cbId;
      callbacks.set(id, once ? (data: unknown) => { callbacks.delete(id); cb(data); } : cb);
      return id;
    }
    function unregisterCallback(id: number): void { callbacks.delete(id); }
    const eventListeners = new Map<number, string>();

    async function invoke(
      cmd: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> {
      if (cmd === "read_text_file") {
        const path = args?.path as string;
        return fileContents.get(path) ?? "";
      }
      if (cmd === "path_exists") {
        const path = args?.path as string;
        return fileContents.has(path);
      }
      if (cmd === "plugin:cli|argv") return [];
      if (cmd === "plugin:dialog|open") return "/virtual/notes/sample.md";
      if (cmd === "plugin:dialog|ask") return false;
      if (cmd === "plugin:dialog|message") return null;

      if (cmd === "write_text_file") {
        const path = args?.path as string;
        const contents = args?.contents as string;
        fileContents.set(path, contents);
        return null;
      }

      if (cmd === "rename_file") {
        const from = args?.from as string;
        const to = args?.to as string;
        if (fileContents.has(to)) {
          throw new Error(`target already exists: ${to}`);
        }
        const contents = fileContents.get(from) ?? "";
        fileContents.delete(from);
        fileContents.set(to, contents);
        const idx = folderFiles.findIndex((f) => f.path === from);
        if (idx >= 0 && to.startsWith(folderRoot + "/")) {
          folderFiles[idx] = { path: to, relative: to.slice(folderRoot.length + 1) };
        }
        (win as Record<string, unknown>).__lastRename = { from, to };
        return null;
      }

      if (cmd === "trash_file") {
        const path = args?.path as string;
        fileContents.delete(path);
        const idx = folderFiles.findIndex((f) => f.path === path);
        if (idx >= 0) folderFiles.splice(idx, 1);
        (win as Record<string, unknown>).__lastTrash = { path };
        return null;
      }

      if (cmd === "list_documents") {
        return folderFiles.map((f) => ({ ...f }));
      }
      if (cmd === "resolve_folder_root") {
        return folderRoot;
      }
      if (cmd === "is_directory") return false;
      if (cmd === "take_pending_open_paths") return [];
      if (cmd === "recents_os_get") return [];
      if (cmd === "recents_os_add") return null;
      if (cmd === "recents_os_clear") return null;
      if (cmd === "list_pairings") return [];
      if (cmd === "list_folder_sync_configs") return [];

      if (
        cmd === "watcher_start" ||
        cmd === "watcher_stop" ||
        cmd === "watcher_mark_self_write" ||
        cmd === "folder_watcher_start" ||
        cmd === "folder_watcher_stop"
      ) return null;

      if (cmd.startsWith("plugin:window|")) return null;
      if (cmd === "plugin:menu|new") return [1, "mock-id"];
      if (cmd.startsWith("plugin:menu|")) return null;

      if (cmd === "plugin:store|load") return 1;
      if (cmd === "plugin:store|get_store") return null;
      if (cmd === "plugin:store|get") {
        const key = args?.key as string | undefined;
        if (key === "currentFolder") return [folderRoot, true];
        return [null, false];
      }
      if (cmd === "plugin:store|has") {
        const key = args?.key as string | undefined;
        return key === "currentFolder";
      }
      if (cmd === "plugin:store|set") return null;
      if (cmd === "plugin:store|save") return null;
      if (cmd === "plugin:store|delete") return false;
      if (cmd === "plugin:store|clear") return null;
      if (cmd === "plugin:store|reset") return null;
      if (cmd === "plugin:store|keys") return ["currentFolder"];
      if (cmd === "plugin:store|values") return [folderRoot];
      if (cmd === "plugin:store|entries") return [["currentFolder", folderRoot]];
      if (cmd === "plugin:store|length") return 1;
      if (cmd === "plugin:store|reload") return null;
      if (cmd.startsWith("plugin:store|")) return null;

      if (cmd === "read_all_recovery") return [];
      if (cmd === "clear_recovery") return null;
      if (cmd === "write_recovery") return null;

      if (cmd === "plugin:event|listen") {
        const handlerId = args?.handler as number | undefined;
        const eventName = args?.event as string | undefined;
        if (handlerId != null && eventName != null) {
          eventListeners.set(handlerId, eventName);
        }
        return handlerId ?? 0;
      }
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
      unregisterListener: (id: number) => {
        eventListeners.delete(id);
        unregisterCallback(id);
      },
    };
  });
}

test("rename a file from the sidebar context menu", async ({ page }) => {
  await installFolderStub(page);
  await page.goto(APP_URL);
  await expect(page.locator(".cm-md-heading-1")).toBeVisible({ timeout: 5000 });

  // The folder sidebar lists sample.md and other.md. Right-click on
  // sample.md (the currently-open file) and pick "Rename…".
  const sampleRow = page.locator(".viewer-folder-file").filter({ hasText: "sample.md" });
  await expect(sampleRow).toBeVisible({ timeout: 5000 });
  await sampleRow.click({ button: "right" });

  const menu = page.locator(".viewer-folder-context-menu");
  await expect(menu).toBeVisible();
  await menu.getByText("Rename…").click();

  const input = page.locator(".viewer-folder-rename-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("sample.md");

  await input.fill("renamed.md");
  await input.press("Enter");

  // Tree shows the new name; old name is gone.
  await expect(
    page.locator(".viewer-folder-file").filter({ hasText: "renamed.md" }),
  ).toBeVisible({ timeout: 4000 });
  await expect(
    page.locator(".viewer-folder-file").filter({ hasText: /^sample\.md$/ }),
  ).toHaveCount(0);

  // rename_file was invoked with the right (from, to).
  const lastRename = await page.evaluate(
    () => (window as unknown as { __lastRename?: { from: string; to: string } }).__lastRename,
  );
  expect(lastRename?.from).toBe("/virtual/notes/sample.md");
  expect(lastRename?.to).toBe("/virtual/notes/renamed.md");

  // The editor's path readout (toolbar / titlebar) follows the rename —
  // the file row gets aria-current=true after the buffer re-targets.
  await expect(
    page.locator(".viewer-folder-file[aria-current='true']").filter({ hasText: "renamed.md" }),
  ).toBeVisible({ timeout: 4000 });
});

test("delete a file via confirmation modal from the sidebar context menu", async ({ page }) => {
  await installFolderStub(page);
  await page.goto(APP_URL);
  await expect(page.locator(".cm-md-heading-1")).toBeVisible({ timeout: 5000 });

  // Right-click on the non-open file (other.md) so we can verify tree
  // removal without entangling the orphan flow on the open buffer.
  const otherRow = page.locator(".viewer-folder-file").filter({ hasText: "other.md" });
  await expect(otherRow).toBeVisible({ timeout: 5000 });
  await otherRow.click({ button: "right" });

  const menu = page.locator(".viewer-folder-context-menu");
  await expect(menu).toBeVisible();
  await menu.getByText("Delete…").click();

  // Confirmation modal appears with the file name.
  const modal = page.locator(".viewer-folder-delete-card");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("other.md");

  // Click Delete.
  await modal.locator(".viewer-folder-delete-confirm").click();

  // File disappears from the tree.
  await expect(
    page.locator(".viewer-folder-file").filter({ hasText: /^other\.md$/ }),
  ).toHaveCount(0, { timeout: 4000 });

  // trash_file was called with the right path.
  const lastTrash = await page.evaluate(
    () => (window as unknown as { __lastTrash?: { path: string } }).__lastTrash,
  );
  expect(lastTrash?.path).toBe("/virtual/notes/other.md");
});

test("delete confirmation Cancel does not invoke trash_file", async ({ page }) => {
  await installFolderStub(page);
  await page.goto(APP_URL);
  await expect(page.locator(".cm-md-heading-1")).toBeVisible({ timeout: 5000 });

  const otherRow = page.locator(".viewer-folder-file").filter({ hasText: "other.md" });
  await expect(otherRow).toBeVisible({ timeout: 5000 });
  await otherRow.click({ button: "right" });

  await page.locator(".viewer-folder-context-menu").getByText("Delete…").click();

  const modal = page.locator(".viewer-folder-delete-card");
  await expect(modal).toBeVisible();

  // Cancel button is the non-confirm button in the modal.
  await modal
    .locator(".viewer-reconcile-buttons button:not(.viewer-folder-delete-confirm)")
    .click();
  await expect(modal).toBeHidden();

  // File still present in the tree.
  await expect(
    page.locator(".viewer-folder-file").filter({ hasText: "other.md" }),
  ).toBeVisible();

  // trash_file was not called.
  const lastTrash = await page.evaluate(
    () => (window as unknown as { __lastTrash?: { path: string } }).__lastTrash,
  );
  expect(lastTrash).toBeUndefined();
});
