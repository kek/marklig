import { test, expect } from "@playwright/test";

const APP_URL = "http://localhost:1420";

test("clicking an external link in reading mode invokes the OS opener", async ({ page }) => {
  await page.addInitScript(() => {
    const sample = "before [example](https://example.com) after\n";

    let cbId = 0;
    const callbacks = new Map<number, (data: unknown) => void>();
    function transformCallback(cb: (data: unknown) => void, once = false): number {
      const id = ++cbId;
      callbacks.set(id, once ? (data: unknown) => { callbacks.delete(id); cb(data); } : cb);
      return id;
    }
    function unregisterCallback(id: number): void { callbacks.delete(id); }
    const eventListeners = new Map<number, (data: unknown) => void>();

    async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      if (cmd === "path_exists") return true;
      if (cmd === "read_text_file") return sample;
      if (cmd === "take_pending_open_paths") return [];
      if (cmd === "plugin:cli|argv") return [];
      if (cmd === "plugin:dialog|open") return "/virtual/sample.md";
      if (cmd === "plugin:dialog|ask") return false;
      if (cmd === "plugin:dialog|message") return null;
      // Capture opener invocations on window for assertion.
      if (cmd === "plugin:opener|open_url") {
        (window as unknown as { __openedUrls?: string[] }).__openedUrls = [
          ...((window as unknown as { __openedUrls?: string[] }).__openedUrls ?? []),
          args?.url as string,
        ];
        return null;
      }
      if (cmd === "plugin:opener|open_path") return null;
      if (cmd === "write_text_file") return null;
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
    }

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
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
  });

  await page.goto(APP_URL);

  // Reading mode is the default. `.cm-md-link-text` — what this test used to
  // look for — is the *edit*-mode mark on the raw `[text](url)` source. Reading
  // mode replaces that source span with a real semantic <a> widget
  // (src/editor/decorations/reading-links.ts, the "Semantic <a> for
  // reading-mode links" work), so the old selector cannot match here and had
  // not matched since that landed: Playwright had never run in CI, so nothing
  // said so. Assert against the anchor the reading view actually builds, and
  // check its href while we are here — the widget carries the target, so this
  // is a stricter precondition than the mark was.
  const link = page.locator("a.cm-md-reading-link").first();
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://example.com");
  await expect(link).toHaveText("example");
  await link.click();

  // The mocked opener should have received the URL.
  await expect.poll(async () =>
    page.evaluate(() => (window as unknown as { __openedUrls?: string[] }).__openedUrls ?? []),
  ).toContain("https://example.com");
});
