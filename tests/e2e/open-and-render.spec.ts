import { test, expect, type Page } from "@playwright/test";

const APP_URL = "http://localhost:1420";

/** Install a Tauri-internals stub so the app boots in a plain browser and
 * `read_text_file` returns `sample`. Mirrors the real Tauri internals enough
 * for bootstrap to run (invoke, event listen/emit, store, recovery). */
async function installTauriStub(page: Page, sample: string): Promise<void> {
  await page.addInitScript((sampleArg: string) => {
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
  }, sample);
}

test("renders headings and code from a sample doc", async ({ page }) => {
  const sample = `# Sample Document\n\nA paragraph with **bold**, *italic*, and \`code\`.\n\n## Lists\n\n- a\n- b\n\n## Code\n\n\`\`\`js\nconst x = 42;\n\`\`\`\n`;
  await installTauriStub(page, sample);

  await page.goto(APP_URL);

  // The heading should be visible with H1 typography (font-size 28px from theme).
  const h1 = page.locator(".cm-md-heading-1");
  await expect(h1).toBeVisible();

  // A list line is present.
  await expect(page.locator(".cm-md-list-bullet").first()).toBeVisible();

  // The code body text is present in the editor — the fence open/close lines are
  // elided in reading mode (cm-md-reading-elide-line), but the body text is always visible.
  await expect(page.locator(".cm-line").filter({ hasText: "const x = 42;" })).toBeVisible();
});

test("syntax-highlights a code fence on initial load with no interaction", async ({ page }) => {
  // Regression: the Shiki highlight result filled the module-global cache, but
  // the "re-render with highlights" dispatch was lost because highlightCache's
  // subscription was registered (far) after the editor was created and its
  // first async highlight request had already resolved into an empty listener
  // set. In reading mode nothing else recomputed the field, so token-color
  // marks never appeared until the user typed / toggled mode. Token marks must
  // be present on load, with zero interaction.
  const sample = `# Doc\n\n\`\`\`ts\nexport const answer: number = 42;\n\`\`\`\n`;
  await installTauriStub(page, sample);

  await page.goto(APP_URL);

  // Body text renders first…
  await expect(
    page.locator(".cm-line").filter({ hasText: "export const answer" }),
  ).toBeVisible();

  // …and the Shiki token-color marks (cm-md-token-<hex>) must appear without
  // any edit or mode toggle. Generous timeout: Shiki primes + computes async.
  await expect(
    page.locator('[class*="cm-md-token-"]').first(),
  ).toBeVisible({ timeout: 10_000 });
});
