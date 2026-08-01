// E2E for the four file-out surfaces with a `.typ` open (issue #57).
//
// This is the only level at which the bug is visible. `buildHtmlExport` is
// thoroughly unit-tested and was never wrong; the fault was in its CALLER —
// `buildCurrentHtml` in the main.ts bootstrap, which has no unit coverage —
// running the Typst *source* through the markdown-it pipeline and writing the
// result into a file the dialog had already named `document.pdf`.
//
// So these specs drive the real menu-action listener and capture the exact
// string handed to each sink: `write_text_file` for Export → HTML, `export_pdf`
// for Export → PDF, `navigator.clipboard.write` for Copy as HTML, and the
// hidden print iframe's DOM for Print.
//
// The stub extends the one in typst-basic.spec.ts with two things it lacks:
// a `plugin:dialog|save` that answers with a destination, and an event bridge
// that actually delivers `viewer:menu-action` to the listener that
// `installMenuActionListener` registered (the other specs swallow every emit,
// which is why no menu action has ever been exercised in e2e).

import { test, expect, type Page } from "@playwright/test";

const APP_URL = "http://localhost:1420";

/** Distinctive Typst source. Every line here is a different way markdown-it
 * gets it wrong: `=`/`==` are Typst headings but Markdown prose, `#set` and
 * `#figure` are Typst code but Markdown prose, and `$…$` is Typst math that
 * markdown-it either passes through or hands to KaTeX by coincidence. */
const TYPST_SOURCE = [
  "= Garbled Heading One",
  "",
  '#set page(width: 10cm, height: 8cm)',
  "",
  "== Garbled Heading Two",
  "",
  "Some #emph[typst emphasis] and $x^2 + y^2$ inline.",
  "",
  "#figure(rect(width: 2cm), caption: [A rectangle])",
].join("\n");

interface Captured {
  writes: Array<{ path: string; contents: string }>;
  pdfs: Array<{ destPath: string; html: string }>;
  clipboard: string[];
  printed: string[];
  saveDialogs: Array<{ defaultPath?: string; filters?: unknown }>;
}

declare global {
  interface Window {
    __captured: Captured;
  }
}

/** Install the Tauri stub plus the sink recorders. `saveDest` is what the save
 * dialog answers with, so a handler proceeds all the way to its sink. */
async function addStubs(page: Page, sample: string, initialPath: string, saveDest: string): Promise<void> {
  await page.addInitScript(({ sample, initialPath, saveDest }) => {
    const captured: Captured = { writes: [], pdfs: [], clipboard: [], printed: [], saveDialogs: [] };
    (window as unknown as { __captured: Captured }).__captured = captured;

    // Print's sink is a hidden iframe that `openPrintWindow` writes the export
    // HTML into and then prints. It is torn down on `afterprint`, which headless
    // Chromium fires the moment `print()` returns — so by the time a spec looks
    // for the iframe it is already gone. Observe its insertion instead:
    // `openPrintWindow` does append → doc.open/write/close synchronously, so a
    // MutationObserver callback (next microtask checkpoint) sees the fully
    // written document. This watches the real production code path; it adds no
    // test hook to it.
    const watchPrintFrames = () => {
      new MutationObserver((records) => {
        for (const r of records) {
          for (const node of Array.from(r.addedNodes)) {
            if (!(node instanceof HTMLIFrameElement)) continue;
            if (node.getAttribute("aria-hidden") !== "true") continue;
            const doc = node.contentDocument;
            if (doc) captured.printed.push(doc.documentElement.outerHTML);
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) watchPrintFrames();
    else document.addEventListener("DOMContentLoaded", watchPrintFrames, { once: true });

    let cbId = 0;
    const callbacks = new Map<number, (data: unknown) => void>();
    function transformCallback(cb: (data: unknown) => void, once = false): number {
      const id = ++cbId;
      callbacks.set(id, once ? (data: unknown) => { callbacks.delete(id); cb(data); } : cb);
      return id;
    }
    function unregisterCallback(id: number): void { callbacks.delete(id); }

    // The event bridge. Only `viewer:menu-action` is delivered; every other
    // emit stays swallowed exactly as in the sibling specs, so turning this on
    // can't set off window-session broadcasts or project-switch routing.
    const MENU_EVENT = "viewer:menu-action";
    const menuListeners: number[] = [];

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "path_exists") return true;
        if (cmd === "read_text_file") return sample;
        if (cmd === "write_text_file") {
          captured.writes.push({
            path: String(args?.path ?? ""),
            contents: String(args?.contents ?? ""),
          });
          return null;
        }
        if (cmd === "export_pdf") {
          captured.pdfs.push({
            destPath: String(args?.destPath ?? ""),
            html: String(args?.html ?? ""),
          });
          return null;
        }
        if (cmd === "take_pending_open_paths") return [initialPath];
        if (cmd === "plugin:cli|argv") return [];
        if (cmd === "plugin:dialog|open") return initialPath;
        if (cmd === "plugin:dialog|save") {
          const opts = (args?.options ?? args) as Record<string, unknown> | undefined;
          captured.saveDialogs.push({
            defaultPath: opts?.defaultPath as string | undefined,
            filters: opts?.filters,
          });
          return saveDest;
        }
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
        if (cmd === "plugin:store|length") return 0;
        if (cmd === "plugin:store|keys" || cmd === "plugin:store|values" || cmd === "plugin:store|entries") return [];
        if (cmd === "plugin:store|delete") return false;
        if (cmd.startsWith("plugin:store|")) return null;
        if (cmd === "read_all_recovery") return [];
        if (cmd === "clear_recovery") return null;
        if (cmd === "write_recovery") return null;
        if (cmd === "typst_open") return "session-mock";
        if (cmd === "typst_compile") {
          // A page shaped like real typst_svg output: a viewBox in points, the
          // `typst-doc` class, and a glyph <use> reference. `data-source-len`
          // lets a spec prove the export saw the current buffer.
          const src = String(args?.source ?? "");
          return {
            pages: [
              `<svg class="typst-doc" viewBox="0 0 283.46 226.77" width="283.46pt" height="226.77pt"` +
                ` xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"` +
                ` data-source-len="${src.length}">` +
                `<defs><symbol id="gA"><path d="M0 0 L1 1 Z"/></symbol></defs>` +
                `<use xlink:href="#gA" x="0" y="0"/>` +
                `<text x="5" y="20">COMPILED TYPST PAGE</text></svg>`,
            ],
            diagnostics: [],
            elapsed_ms: 1,
          };
        }
        if (cmd === "typst_close") return null;
        if (cmd === "plugin:event|listen") {
          const handlerId = args?.handler as number | undefined;
          if (handlerId != null && String(args?.event ?? "") === MENU_EVENT) {
            menuListeners.push(handlerId);
          }
          return handlerId ?? 0;
        }
        if (cmd === "plugin:event|unlisten") {
          const handlerId = args?.id as number | undefined;
          if (handlerId != null) {
            const i = menuListeners.indexOf(handlerId);
            if (i >= 0) menuListeners.splice(i, 1);
            unregisterCallback(handlerId);
          }
          return null;
        }
        if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
          if (String(args?.event ?? "") === MENU_EVENT) {
            for (const id of [...menuListeners]) {
              callbacks.get(id)?.({ event: MENU_EVENT, id, payload: args?.payload });
            }
          }
          return null;
        }
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
        const i = menuListeners.indexOf(id);
        if (i >= 0) menuListeners.splice(i, 1);
        unregisterCallback(id);
      },
    };

    // Copy as HTML's sink. Read the text/html blob eagerly — the spec polls
    // `captured.clipboard`, so the value has to land without further awaiting.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: Array<{ getType: (t: string) => Promise<Blob> }>) => {
          for (const item of items) {
            const blob = await item.getType("text/html");
            captured.clipboard.push(await blob.text());
          }
        },
      },
    });
  }, { sample, initialPath, saveDest });
}

/** Fire a File-menu action into the window, the way the native menu does. */
async function fireMenuAction(page: Page, action: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (payload) => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    await internals.invoke("plugin:event|emit_to", {
      target: { kind: "Window", label: "main" },
      event: "viewer:menu-action",
      payload,
    });
  }, action);
}

/** Wait for the .typ to be open and its first page compiled into the pane. */
async function openTypstDoc(page: Page): Promise<void> {
  await page.goto(APP_URL);
  await page.waitForSelector(".cm-editor", { state: "attached" });
  await expect(page.locator(".preview-pane-body .typst-page svg"))
    .toHaveCount(1, { timeout: 10_000 });
}

/** Every assertion that makes "this is not a markdown-it render of the Typst
 * source" concrete, plus the positive "this is the compiled document". */
function expectCompiledTypstNotMarkdown(html: string): void {
  // Positive: the compiled pages are what got handed over.
  expect(html).toContain("COMPILED TYPST PAGE");
  expect(html).toContain(`class="typst-page"`);
  expect(html).toContain(`viewBox="0 0 283.46 226.77"`);
  // The page box came from the document, not from US Letter.
  expect(html).toContain("@page { size: 283.46pt 226.77pt; margin: 0; }");

  // Negative: not one trace of the Typst source having been through
  // markdown-it. `= Garbled Heading One` renders as `<p>= Garbled Heading
  // One</p>`; the `#`-prefixed code lines render as prose paragraphs.
  expect(html).not.toContain("Garbled Heading One");
  expect(html).not.toContain("Garbled Heading Two");
  expect(html).not.toContain("#set page");
  expect(html).not.toContain("#figure");
  expect(html).not.toContain("typst emphasis");
  expect(html).not.toContain("<p>= ");
  // The markdown pipeline's own fingerprints: its default title and the
  // KaTeX stylesheet it inlines.
  expect(html).not.toContain("Markdown export");
  expect(html).not.toContain("katex");
}

test("Export → HTML writes the compiled pages, not a markdown render of the source", async ({ page }) => {
  await addStubs(page, TYPST_SOURCE, "/virtual/doc.typ", "/virtual/out.html");
  await openTypstDoc(page);

  await fireMenuAction(page, { type: "exportHtml" });

  const html = await pollForWrite(page, "/virtual/out.html");
  expectCompiledTypstNotMarkdown(html);
  // The compile that produced these pages saw the whole buffer.
  expect(html).toContain(`data-source-len="${TYPST_SOURCE.length}"`);
});

test("Export → PDF hands the compiled pages to the native PDF capture", async ({ page }) => {
  await addStubs(page, TYPST_SOURCE, "/virtual/doc.typ", "/virtual/out.pdf");
  await openTypstDoc(page);

  await fireMenuAction(page, { type: "exportPdf" });

  const pdf = await pollFor(page, () => window.__captured.pdfs[0] ?? null);
  expect(pdf.destPath).toBe("/virtual/out.pdf");
  expectCompiledTypstNotMarkdown(pdf.html);
});

test("Copy as HTML puts the compiled pages on the clipboard", async ({ page }) => {
  await addStubs(page, TYPST_SOURCE, "/virtual/doc.typ", "/virtual/unused");
  await openTypstDoc(page);

  await fireMenuAction(page, { type: "copyAsHtml" });

  await expect.poll(
    async () => await page.evaluate(() => window.__captured.clipboard.length),
    { timeout: 10_000 },
  ).toBe(1);
  const html = await page.evaluate(() => window.__captured.clipboard[0]);
  expectCompiledTypstNotMarkdown(html);
});

test("Print renders the compiled pages into the print frame", async ({ page }) => {
  await addStubs(page, TYPST_SOURCE, "/virtual/doc.typ", "/virtual/unused");
  await openTypstDoc(page);

  await fireMenuAction(page, { type: "printDocument" });

  await expect.poll(
    async () => await page.evaluate(() => window.__captured.printed.length),
    { timeout: 10_000 },
  ).toBe(1);
  const printed = await page.evaluate(() => window.__captured.printed[0]);
  expectCompiledTypstNotMarkdown(printed);
});

test("Save As on a .typ offers a .typ name and a Typst filter, not Markdown", async ({ page }) => {
  await addStubs(page, TYPST_SOURCE, "/virtual/doc.typ", "/virtual/copy.typ");
  await openTypstDoc(page);

  await fireMenuAction(page, { type: "saveFileAs" });

  const dialog = await pollFor(page, () => window.__captured.saveDialogs[0] ?? null);
  expect(dialog.defaultPath).toBe("doc.typ");
  expect(JSON.stringify(dialog.filters)).toContain("typ");
  expect(JSON.stringify(dialog.filters)).not.toContain("markdown");

  // And the buffer written out is the Typst source, unconverted.
  const written = await page.evaluate(() =>
    window.__captured.writes.find((w) => w.path === "/virtual/copy.typ") ?? null,
  );
  expect(written?.contents).toBe(TYPST_SOURCE);
});

// The control: correcting the Typst path must not have changed the Markdown
// path, which was always right. Without this, "don't run it through
// markdown-it" could be satisfied by breaking Markdown export too.
test("a .md document still exports through the markdown-it pipeline", async ({ page }) => {
  const markdown = "# Real Markdown Heading\n\nA *paragraph* of prose.\n";
  await addStubs(page, markdown, "/virtual/doc.md", "/virtual/out.html");
  await page.goto(APP_URL);
  await page.waitForSelector(".cm-editor", { state: "visible" });
  // No preview pane for markdown — that's the .typ layout.
  await expect(page.locator(".preview-pane")).toBeHidden();

  await fireMenuAction(page, { type: "exportHtml" });

  const html = await pollForWrite(page, "/virtual/out.html");
  expect(html).toContain("<h1>Real Markdown Heading</h1>");
  expect(html).toContain("<em>paragraph</em>");
  expect(html).not.toContain("typst-page");
});

async function pollForWrite(page: Page, path: string): Promise<string> {
  await expect.poll(
    async () => await page.evaluate(
      (p) => window.__captured.writes.some((w) => w.path === p),
      path,
    ),
    { timeout: 10_000 },
  ).toBe(true);
  return await page.evaluate(
    (p) => window.__captured.writes.find((w) => w.path === p)!.contents,
    path,
  );
}

/** Poll a capture slot in the page until it is non-null, then return it. */
async function pollFor<T>(page: Page, read: () => T | null): Promise<T> {
  await expect.poll(
    async () => (await page.evaluate(read)) !== null,
    { timeout: 10_000 },
  ).toBe(true);
  return (await page.evaluate(read)) as T;
}
