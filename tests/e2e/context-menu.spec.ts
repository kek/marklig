// E2E for the custom editor context menu (issue #103). Stubs Tauri the
// same way the other specs in this directory do — see open-and-render
// and edit-and-save for the same harness.

import { test, expect } from "@playwright/test";

const APP_URL = "http://localhost:1420";

test("right-click opens the custom menu; mode toggle swaps the item set", async ({ page }) => {
  await page.addInitScript(() => {
    const sample = "# Hello\n\nA paragraph.\n";

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
        // readDoc probes existence first, then reads — both must be stubbed
        // or the sample appears as an empty new-file buffer.
        if (cmd === "path_exists") return true;
        if (cmd === "read_text_file") return sample;
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
        // bootstrap path: classifyOpenPaths reads `.length` off the result, so
        // we must return an array even if no file was handed to us.
        if (cmd === "take_pending_open_paths") return [];
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
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser:error]", msg.text());
  });
  page.on("pageerror", (e) => console.log("[browser:pageerror]", e.message));

  await page.goto(APP_URL);

  // Wait for the editor to mount. Once mounted, the document is loaded from
  // the mocked read_text_file. Reading mode is the initial mode.
  await page.waitForSelector(".cm-content");
  // Then verify the heading actually rendered with our content.
  await expect(page.locator(".cm-md-heading-1")).toBeVisible();

  const menu = page.locator(".viewer-context-menu");

  // Right-click on the editor surface. Click on the heading line so we hit
  // an editor element rather than empty area outside .cm-content.
  // Use page.mouse: Playwright's .click({button: "right"}) doesn't reliably
  // fire contextmenu in webkit/chromium; mouse.click with right button does.
  //
  // Retried via toPass() because this is a one-shot *gesture*, not a matcher
  // that polls: if it lands in the window between .cm-md-heading-1 painting and
  // mountContextMenu() attaching its listener — which vite's dep-optimizer
  // full-reload on the first page load of a cold run can widen — the event
  // falls on the floor and no amount of waiting afterwards will produce a menu.
  // That is exactly how this failed on the macos-latest runner (5s waiting for
  // .viewer-context-menu, "element(s) not found") while passing on
  // ubuntu-latest and locally. Retrying the gesture keeps the assertion
  // intact — the menu still has to appear — and removes the race.
  await expect(async () => {
    const handle = page.locator(".cm-line").first();
    const box = await handle.boundingBox();
    if (!box) throw new Error("could not measure cm-line bbox");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    await expect(menu).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  // Reading-mode menu, no selection: Find, Reveal, Switch to Edit.
  await expect(menu.locator(".viewer-context-menu-item")).toContainText([
    /Find/,
    /(Reveal|Show in)/,
    /Switch to Edit Mode/,
  ]);
  // Edit-only items must NOT appear in reading mode.
  await expect(menu).not.toContainText("Paste");
  await expect(menu).not.toContainText("Cut");

  // Click "Switch to Edit Mode" to swap mode.
  await menu.getByText("Switch to Edit Mode").click();
  await expect(menu).toBeHidden();

  // Verify the source markup is now visible (edit mode).
  await expect(page.locator(".cm-line").filter({ hasText: "# Hello" })).toBeVisible();

  // Right-click again in edit mode. The custom menu should NOT appear —
  // we hand back to the platform's native menu so its useful items
  // (spelling suggestions, Look Up, Make Uppercase) remain available
  // against the now-writable buffer.
  {
    const handle = page.locator(".cm-line").first();
    const box = await handle.boundingBox();
    if (!box) throw new Error("could not measure cm-line bbox");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
  }
  // Give any popup a beat to mount, then assert ours did not.
  await page.waitForTimeout(100);
  await expect(menu).toBeHidden();
});
