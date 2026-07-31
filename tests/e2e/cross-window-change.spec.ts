import { test, expect, type Page } from "@playwright/test";

const APP_URL = "http://localhost:1420";

/** Install a Tauri-internals stub that models a *multi-window* app.
 *
 * Two things it does that the single-window stubs don't:
 *
 *  * `files` is a path → contents map, so `read_text_file` answers per path.
 *    A window that reloads the wrong document therefore renders text no other
 *    window has, which is what makes "did window B reload?" observable.
 *  * `__reads` records every `read_text_file` path. A reload *is* a re-read,
 *    so an unchanged read log is direct evidence that a window stayed put —
 *    stronger than "no notice appeared", which a slow reload would also
 *    satisfy.
 */
async function installTauriStub(
  page: Page,
  label: string,
  files: Record<string, string>,
): Promise<void> {
  await page.addInitScript(
    ({ labelArg, filesArg }: { labelArg: string; filesArg: Record<string, string> }) => {
      const win = window as unknown as Record<string, unknown>;
      const contents = new Map<string, string>(Object.entries(filesArg));
      const reads: string[] = [];
      win.__reads = reads;
      win.__setContent = (path: string, text: string) => contents.set(path, text);

      // ── Callback registry (mirrors the real Tauri internals) ────────────
      let cbId = 0;
      const callbacks = new Map<number, (data: unknown) => void>();
      function transformCallback(cb: (data: unknown) => void, once = false): number {
        const id = ++cbId;
        callbacks.set(id, once ? (data: unknown) => { callbacks.delete(id); cb(data); } : cb);
        return id;
      }
      function unregisterCallback(id: number): void { callbacks.delete(id); }

      // ── Event listener registry, keyed by event name ─────────────────────
      const eventListeners = new Map<number, string>();
      win.__fireEvent = (eventName: string, payload: unknown) => {
        for (const [handlerId, name] of eventListeners) {
          if (name !== eventName) continue;
          const cb = callbacks.get(handlerId);
          if (cb) cb({ id: handlerId, event: eventName, payload });
        }
      };

      async function invoke(
        cmd: string,
        args?: Record<string, unknown>,
      ): Promise<unknown> {
        if (cmd === "path_exists") return contents.has(args?.path as string);
        if (cmd === "read_text_file") {
          const path = args?.path as string;
          reads.push(path);
          return contents.get(path) ?? "";
        }
        if (cmd === "take_pending_open_paths") return [];
        if (cmd === "plugin:cli|argv") return [];
        if (cmd === "plugin:dialog|open") return null;
        if (cmd === "plugin:dialog|ask") return false;
        if (cmd === "plugin:dialog|message") return null;

        if (cmd === "write_text_file") {
          contents.set(args?.path as string, args?.contents as string);
          return null;
        }

        // Watcher commands — no-op. Which window a real watcher would have
        // emitted to is modelled by the test's broadcast helper, not here.
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
        if (cmd === "plugin:store|get") return [null, false];
        if (cmd === "plugin:store|has") return false;
        if (cmd === "plugin:store|length") return 0;
        if (cmd === "plugin:store|keys") return [];
        if (cmd === "plugin:store|values") return [];
        if (cmd === "plugin:store|entries") return [];
        if (cmd === "plugin:store|delete") return false;
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
          currentWindow: { label: labelArg },
          currentWebview: { windowLabel: labelArg, label: labelArg },
        },
      };
      win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (id: number) => {
          eventListeners.delete(id);
          unregisterCallback(id);
        },
      };
    },
    { labelArg: label, filesArg: files },
  );
}

/** Open a window on `file`, and wait until it has rendered. */
async function openWindow(
  page: Page,
  label: string,
  files: Record<string, string>,
  file: string,
): Promise<void> {
  await installTauriStub(page, label, files);
  await page.goto(`${APP_URL}/?file=${encodeURIComponent(file)}`);
  await expect(page.locator(".cm-md-heading-1")).toBeVisible();
}

/**
 * Deliver one watcher event the way Tauri v2 actually delivers it.
 *
 * The Rust watcher emits with `emit_to(label, …)`, which reads as "only that
 * window", but a frontend `listen()` registers with `EventTarget::Any` and so
 * receives the event regardless of the target named. That is not a guess: it
 * is what #145 was — `viewer:open-file` was `emitTo`-ed at one window and
 * fired the handler in all five open ones — and the delivery path has not
 * changed since. So one window's watcher event arrives in *every* window, and
 * a test that fired it into a single page would be testing a Tauri that does
 * not exist.
 */
async function deliverWatcherEventToAllWindows(
  pages: Page[],
  event: { kind: "modified" | "removed"; path: string },
): Promise<void> {
  for (const page of pages) {
    await page.evaluate((ev) => {
      const fire = (window as unknown as {
        __fireEvent: (name: string, payload: unknown) => void;
      }).__fireEvent;
      fire("viewer://file-changed", ev);
    }, event);
  }
}

async function readLog(page: Page): Promise<string[]> {
  return await page.evaluate(
    () => [...((window as unknown as { __reads: string[] }).__reads ?? [])],
  );
}

/** Switch a window into edit mode and type, leaving it dirty. */
async function makeDirty(page: Page, text: string): Promise<void> {
  await page.locator(".viewer-toolbar-btn, .viewer-titlebar-btn").first().click();
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.locator(".cm-content").focus();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
  await expect(
    page.locator(".viewer-dirty-indicator, .viewer-titlebar-dirty"),
  ).toContainText("•");
}

test.describe("a watcher event only concerns the windows holding that file", () => {
  test("an external edit to one window's file leaves another window alone", async ({
    browser,
  }) => {
    const files = {
      "/virtual/alpha.md": "# Alpha\n\nAlpha body.\n",
      "/virtual/beta.md": "# Beta\n\nBeta body.\n",
    };
    const context = await browser.newContext();
    const alpha = await context.newPage();
    const beta = await context.newPage();
    await openWindow(alpha, "main", files, "/virtual/alpha.md");
    await openWindow(beta, "window-1", files, "/virtual/beta.md");

    await expect(alpha.locator(".cm-line").filter({ hasText: "Alpha body." })).toBeVisible();
    await expect(beta.locator(".cm-line").filter({ hasText: "Beta body." })).toBeVisible();
    const betaReadsBefore = await readLog(beta);

    // Someone edits alpha.md outside the app. Beta's file is untouched on
    // disk — but give it a distinguishable body anyway, so that if beta
    // re-reads it we can see that it did.
    await alpha.evaluate(() => {
      (window as unknown as { __setContent: (p: string, t: string) => void })
        .__setContent("/virtual/alpha.md", "# Alpha\n\nAlpha changed externally.\n");
    });
    await beta.evaluate(() => {
      (window as unknown as { __setContent: (p: string, t: string) => void })
        .__setContent("/virtual/beta.md", "# Beta\n\nBeta was re-read from disk.\n");
    });

    await deliverWatcherEventToAllWindows([alpha, beta], {
      kind: "modified",
      path: "/virtual/alpha.md",
    });

    // Alpha must reload: that is the feature, and it also serves as the
    // synchronisation point — once alpha has finished reacting, beta has had
    // the same event for at least as long, so "beta has not reloaded" is a
    // settled fact and not a race.
    await expect(alpha.locator(".viewer-reloaded-notice")).toBeVisible({ timeout: 4000 });
    await expect(
      alpha.locator(".cm-line").filter({ hasText: "Alpha changed externally." }),
    ).toBeVisible();

    expect(await readLog(beta)).toEqual(betaReadsBefore);
    await expect(beta.locator(".viewer-reloaded-notice")).toHaveCount(0);
    await expect(beta.locator(".cm-line").filter({ hasText: "Beta body." })).toBeVisible();
    await expect(
      beta.locator(".cm-line").filter({ hasText: "Beta was re-read from disk." }),
    ).toHaveCount(0);

    await context.close();
  });

  test("a dirty window is not asked to reconcile someone else's file", async ({
    browser,
  }) => {
    // The sharpest form of the bug: beta has unsaved edits to beta.md, and an
    // external edit to *alpha.md* puts a modal in front of beta asking it to
    // choose between its edits and a change to a file it does not have open.
    // Whichever button the user picks is wrong: "reload" discards their work
    // for nothing, "keep my edits" sets `diverged` and silently stops beta
    // auto-reloading for the rest of the session.
    const files = {
      "/virtual/alpha.md": "# Alpha\n\nAlpha body.\n",
      "/virtual/beta.md": "# Beta\n\nBeta body.\n",
    };
    const context = await browser.newContext();
    const alpha = await context.newPage();
    const beta = await context.newPage();
    await openWindow(alpha, "main", files, "/virtual/alpha.md");
    await openWindow(beta, "window-1", files, "/virtual/beta.md");

    await makeDirty(beta, " and unsaved work");

    await alpha.evaluate(() => {
      (window as unknown as { __setContent: (p: string, t: string) => void })
        .__setContent("/virtual/alpha.md", "# Alpha\n\nAlpha changed externally.\n");
    });

    await deliverWatcherEventToAllWindows([alpha, beta], {
      kind: "modified",
      path: "/virtual/alpha.md",
    });

    await expect(alpha.locator(".viewer-reloaded-notice")).toBeVisible({ timeout: 4000 });

    await expect(beta.locator(".viewer-reconcile-overlay")).toHaveCount(0);
    await expect(
      beta.locator(".cm-line").filter({ hasText: "and unsaved work" }),
    ).toBeVisible();
    await expect(
      beta.locator(".viewer-dirty-indicator, .viewer-titlebar-dirty"),
    ).toContainText("•");

    await context.close();
  });

  test("a removal in one window does not orphan another window's document", async ({
    browser,
  }) => {
    const files = {
      "/virtual/alpha.md": "# Alpha\n\nAlpha body.\n",
      "/virtual/beta.md": "# Beta\n\nBeta body.\n",
    };
    const context = await browser.newContext();
    const alpha = await context.newPage();
    const beta = await context.newPage();
    await openWindow(alpha, "main", files, "/virtual/alpha.md");
    await openWindow(beta, "window-1", files, "/virtual/beta.md");

    await deliverWatcherEventToAllWindows([alpha, beta], {
      kind: "removed",
      path: "/virtual/alpha.md",
    });

    await expect(alpha.locator(".viewer-orphan-notice")).toBeVisible({ timeout: 4000 });
    await expect(beta.locator(".viewer-orphan-notice")).toHaveCount(0);

    await context.close();
  });

  test("two windows on the SAME file both still reload", async ({ browser }) => {
    // The other half of the requirement: discrimination must not be a mute
    // button. Two windows on one file is legitimate, and both are showing the
    // stale text, so both must refresh.
    //
    // Delivery here is two events, not one, because that is what the backend
    // does: `watcher_start` keys its watchers by window label, so each window
    // has its own watcher on the file's parent directory and each emits its
    // own event for the same change — spelled with the path *that* window
    // asked to watch.
    const files = { "/virtual/shared.md": "# Shared\n\nShared body.\n" };
    const context = await browser.newContext();
    const first = await context.newPage();
    const second = await context.newPage();
    await openWindow(first, "main", files, "/virtual/shared.md");
    await openWindow(second, "window-1", files, "/virtual/shared.md");

    for (const page of [first, second]) {
      await page.evaluate(() => {
        (window as unknown as { __setContent: (p: string, t: string) => void })
          .__setContent("/virtual/shared.md", "# Shared\n\nShared changed externally.\n");
      });
    }

    await deliverWatcherEventToAllWindows([first, second], {
      kind: "modified",
      path: "/virtual/shared.md",
    });
    await deliverWatcherEventToAllWindows([first, second], {
      kind: "modified",
      path: "/virtual/shared.md",
    });

    for (const page of [first, second]) {
      // `.first()`: both events are this window's business, so it reloads
      // twice and posts two notices. Reloading identical content twice is
      // invisible to the user; suppressing the duplicate is a different
      // change (debouncing) and not this one.
      await expect(page.locator(".viewer-reloaded-notice").first())
        .toBeVisible({ timeout: 4000 });
      await expect(
        page.locator(".cm-line").filter({ hasText: "Shared changed externally." }),
      ).toBeVisible();
    }

    await context.close();
  });
});
