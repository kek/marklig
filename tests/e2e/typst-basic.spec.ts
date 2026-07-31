import { test, expect } from "@playwright/test";

const APP_URL = "http://localhost:1420";

/** Install a minimal Tauri stub that also handles the three Typst commands.
 *  `typst_compile` returns one mock SVG page so the pane can assert the
 *  render path wires up; the SVG round-trips through DOMPurify's svg profile. */
async function addTauriStubs(page: import("@playwright/test").Page, sample: string, initialPath: string): Promise<void> {
  await page.addInitScript(({ sample, initialPath }) => {
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
        if (cmd === "take_pending_open_paths") return [initialPath];
        if (cmd === "plugin:cli|argv") return [];
        if (cmd === "plugin:dialog|open") return initialPath;
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
        if (cmd === "typst_open") return "session-mock";
        if (cmd === "typst_compile") {
          // Embed the incoming source as a data attribute so we can both
          // (a) verify a page rendered and (b) check the compile pipeline
          // saw the up-to-date source.
          const src = String(args?.source ?? "");
          return {
            pages: [
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30" data-source-len="${src.length}"><text x="5" y="20">Typst Mock</text></svg>`,
            ],
            diagnostics: [],
            elapsed_ms: 1,
          };
        }
        if (cmd === "typst_close") return null;
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
  }, { sample, initialPath });
}

test("opens .typ, renders pages in the preview pane", async ({ page }) => {
  const sample = "= Sample Typst document\n\nHello *world*.\n";
  await addTauriStubs(page, sample, "/virtual/sample.typ");

  await page.goto(APP_URL);
  // Reading mode for .typ hides the editor (display:none), so wait for it
  // to be attached rather than visible.
  await page.waitForSelector(".cm-editor", { state: "attached" });

  // .typ files default-open the pane (Phase B/D) and in reading mode the
  // pane is the only surface (Phase F). Allow up to 10s for the first
  // compile — the first call traditionally pays a font-scan cost on the
  // Rust side; the stub responds instantly, but the 300ms debounce +
  // bootstrap latency still need a comfortable budget.
  await expect(page.locator(".preview-pane")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".preview-pane-body .typst-page svg"))
    .toHaveCount(1, { timeout: 10_000 });
});

test("edits in the editor trigger a re-compile", async ({ page }) => {
  const sample = "= Initial\n";
  await addTauriStubs(page, sample, "/virtual/sample.typ");

  await page.goto(APP_URL);
  // Reading mode for .typ hides the editor (display:none), so wait for it
  // to be attached rather than visible.
  await page.waitForSelector(".cm-editor", { state: "attached" });
  await expect(page.locator(".preview-pane-body .typst-page svg"))
    .toHaveCount(1, { timeout: 10_000 });

  // First render reflects the initial source length.
  const initialLen = await page.locator(".preview-pane-body svg").getAttribute("data-source-len");
  expect(Number(initialLen)).toBe(sample.length);

  // Phase F: .typ defaults to reading mode where the editor is hidden, so
  // toggle to edit mode before typing. We dispatch via the toolbar's edit
  // toggle (its `aria-pressed` attribute lets us wait for the toggle to
  // commit before typing).
  const editToggle = page.locator(
    ".viewer-toolbar-btn[aria-pressed='false'], .viewer-titlebar-btn[aria-pressed='false']",
  ).first();
  await editToggle.click();
  // Editor source is visible in edit mode — wait for that to actually
  // happen before we drive keystrokes into it.
  await page.locator(".cm-editor").waitFor({ state: "visible" });
  await page.locator(".cm-content").click();
  await page.keyboard.type(" extra");

  // After the debounce we should see a new SVG whose embedded source length
  // matches the updated buffer.
  await expect.poll(async () => {
    return await page.locator(".preview-pane-body svg").getAttribute("data-source-len");
  }, { timeout: 10_000 }).not.toBe(initialLen);
});
