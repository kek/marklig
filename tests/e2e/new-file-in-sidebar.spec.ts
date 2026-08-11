import { test, expect } from "@playwright/test";

const APP_URL = "http://localhost:1420";

test("create a new file from the folder sidebar header '+'", async ({ page }) => {
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;

    // In-memory folder state. The sidebar lists what's here; write_text_file
    // appends an entry so the post-create refresh sees the new file the same
    // way the watcher would on real fs.
    interface FileEntry { path: string; relative: string }
    const folderRoot = "/virtual/notes";
    const folderFiles: FileEntry[] = [
      { path: "/virtual/notes/sample.md", relative: "sample.md" },
    ];
    const fileContents = new Map<string, string>([
      ["/virtual/notes/sample.md", "# Sample\n\nExisting content.\n"],
    ]);
    win.__folderFiles = folderFiles;
    win.__fileContents = fileContents;

    // ── Callback registry ──────────────────────────────────────────────
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
      // Bootstrap eventually falls through to openFileViaDialog() — return
      // the existing sample file so the editor loads, then syncFolderToFile
      // picks up the folder root via resolve_folder_root below.
      if (cmd === "plugin:dialog|open") return "/virtual/notes/sample.md";
      if (cmd === "plugin:dialog|ask") return false;
      if (cmd === "plugin:dialog|message") return null;

      if (cmd === "write_text_file") {
        const path = args?.path as string;
        const contents = args?.contents as string;
        const previouslyExisted = fileContents.has(path);
        fileContents.set(path, contents);
        if (!previouslyExisted && path.startsWith(folderRoot + "/")) {
          folderFiles.push({
            path,
            relative: path.slice(folderRoot.length + 1),
          });
        }
        (win as Record<string, unknown>).__lastWrite = { path, contents };
        return null;
      }

      if (cmd === "list_documents") {
        // Return a defensive copy so the frontend never mutates our state.
        return folderFiles.map((f) => ({ ...f }));
      }
      if (cmd === "resolve_folder_root") {
        return folderRoot;
      }
      // setCurrentFolder() canonicalizes the root before its identity check
      // (issue #99). The real backend answers with std::fs::canonicalize; a
      // stub that fell through to the default `null` made currentFolder null,
      // so `root === currentFolder` held and the sidebar silently never
      // opened. Echo the path back, as the backend does for an already-
      // absolute, symlink-free one.
      if (cmd === "canonicalize_path") return args?.path as string;
      if (cmd === "is_directory") return false;
      if (cmd === "take_pending_open_paths") return [];
      if (cmd === "recents_os_get") return [];
      if (cmd === "recents_os_add") return null;
      if (cmd === "recents_os_clear") return null;
      if (cmd === "list_pairings") return [];
      if (cmd === "list_folder_sync_configs") return [];

      // Folder watcher commands — no-op
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

      // Store plugin — the bootstrap reads currentFolder from here so the
      // folder sidebar opens straight away without needing the dialog.
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

  await page.goto(`${APP_URL}/?file=${encodeURIComponent("/virtual/notes/sample.md")}`);

  // Wait for the app to render — reading mode produces the initial doc's
  // heading. Once that's painted, the folder sidebar's setFolder() has
  // also resolved, so the "+" affordance is on screen.
  await expect(page.locator(".cm-md-heading-1")).toBeVisible({ timeout: 5000 });

  // "+" button is visible in the folder sidebar header.
  const plusBtn = page.locator(".viewer-folder-new-file");
  await expect(plusBtn).toBeVisible({ timeout: 5000 });

  // Click "+" and the inline input appears with "untitled.md" pre-filled.
  await plusBtn.click();
  const input = page.locator(".viewer-folder-new-file-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("untitled.md");

  // Type a name. The input's stem is pre-selected by JS, but we don't rely
  // on that — explicitly clear and type to avoid OS-keyboard sensitivity.
  await input.fill("new-thought.md");
  await input.press("Enter");

  // The new file appears in the tree.
  await expect(
    page.locator(".viewer-folder-file").filter({ hasText: "new-thought.md" }),
  ).toBeVisible({ timeout: 4000 });

  // write_text_file was called with the right path and an empty body.
  const lastWrite = await page.evaluate(
    () => (window as unknown as { __lastWrite?: { path: string; contents: string } }).__lastWrite,
  );
  expect(lastWrite?.path).toBe("/virtual/notes/new-thought.md");
  expect(lastWrite?.contents).toBe("");

  // The editor lands in edit mode showing the new file (empty buffer). The
  // dataset-mode attribute is the simplest signal — the toolbar toggle
  // sets it, and so does the auto-switch in loadAndApplyDoc for new files.
  await expect(page.locator("html")).toHaveAttribute("data-mode", "edit");
});
