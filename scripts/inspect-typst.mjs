#!/usr/bin/env node
// Debug harness for the Typst preview-pane layout.
//
// Loads the running Vite dev server (start it manually with `npm run dev`),
// stubs out Tauri's invoke so the app behaves as if .typ files compile
// successfully, and dumps the DOM + a screenshot for reading mode and
// edit mode. Compares computed-style and class state for the elements
// that actually determine layout so we can diagnose CSS issues without
// the real desktop window.
//
// Run: `npm run dev` in one terminal, then `node scripts/inspect-typst.mjs`.

import { chromium } from "playwright";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const APP_URL = process.env.APP_URL ?? "http://localhost:1420";
const OUT_DIR = resolve(__dirname, "..", "debug-out");
const SAMPLE = `= Sample Typst document

This is a *minimal* sample to show that the preview pane works.

== Math

$ x = (-b plus.minus sqrt(b^2 - 4 a c)) / (2 a) $

== A list

- one
- two
- three
`;
const INITIAL_PATH = "/virtual/sample.typ";

// Real typst-svg output, dumped via the src-tauri/tests/typst_svg_dump test.
// Has explicit pt-unit width/height attributes — matches what the real Tauri
// command returns. Used instead of a viewBox-only mock so we surface
// WebKit/SVG sizing bugs in the harness.
const REAL_SVG = await readFile("/tmp/typst-page.svg", "utf8").catch(() => null);

const tauriStub = ({ sample, initialPath, realSvg }) => {
  let cbId = 0;
  const callbacks = new Map();
  function transformCallback(cb, once = false) {
    const id = ++cbId;
    callbacks.set(id, once ? (data) => { callbacks.delete(id); cb(data); } : cb);
    return id;
  }
  function unregisterCallback(id) { callbacks.delete(id); }
  const eventListeners = new Map();

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
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
        // Use the real typst-svg output if available (preferred — surfaces
        // WebKit pt-unit attribute quirks). Fall back to a synthetic SVG
        // for environments where the dump isn't on disk.
        const src = String(args?.source ?? "");
        const svg = realSvg
          ? realSvg.replace("<svg ", `<svg data-source-len="${src.length}" `)
          : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595 842" data-source-len="${src.length}"><rect x="0" y="0" width="595" height="842" fill="#fffefa" stroke="#ddd"/><text x="40" y="80" font-family="Iowan Old Style, serif" font-size="40" fill="#222">Mock</text></svg>`;
        return {
          pages: [svg],
          diagnostics: [],
          elapsed_ms: 1,
        };
      }
      if (cmd === "typst_close") return null;
      if (cmd === "plugin:event|listen") {
        const handlerId = args?.handler;
        if (handlerId != null) eventListeners.set(handlerId, callbacks.get(handlerId) ?? (() => {}));
        return handlerId ?? 0;
      }
      if (cmd === "plugin:event|unlisten") {
        const handlerId = args?.id;
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

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (id) => {
      eventListeners.delete(id);
      unregisterCallback(id);
    },
  };
};

/** Capture key info about the layout: classes on shell + html, displays
 * of the shell children, and the rendered SVG dimensions. */
async function captureLayout(page, label) {
  return await page.evaluate((label) => {
    function describe(el) {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        class: el.className,
        display: cs.display,
        width: cs.width,
        height: cs.height,
        visibility: cs.visibility,
        offsetWidth: el instanceof HTMLElement ? el.offsetWidth : null,
        offsetHeight: el instanceof HTMLElement ? el.offsetHeight : null,
      };
    }
    const html = document.documentElement;
    const shell = document.querySelector(".viewer-app-shell");
    const sidebar = document.querySelector(".viewer-toc");
    const editor = document.querySelector(".cm-editor");
    const splitter = document.querySelector(".preview-splitter");
    const pane = document.querySelector(".preview-pane");
    const paneBody = document.querySelector(".preview-pane-body");
    const page1Svg = document.querySelector(".preview-pane-body .typst-page svg");
    const shellChildren = shell ? Array.from(shell.children).map((c) => ({
      tag: c.tagName.toLowerCase(),
      class: c.className,
      display: getComputedStyle(c).display,
      offsetWidth: c.offsetWidth,
      offsetHeight: c.offsetHeight,
    })) : [];
    return {
      label,
      htmlDataset: { mode: html.dataset.mode, format: html.dataset.format, theme: html.dataset.theme },
      shellClass: shell?.className,
      shellDisplay: shell ? getComputedStyle(shell).display : null,
      shellChildren,
      sidebar: describe(sidebar),
      editor: describe(editor),
      splitter: describe(splitter),
      pane: describe(pane),
      paneBody: describe(paneBody),
      paneBodyHTML: paneBody?.innerHTML?.slice(0, 200) ?? null,
      cmContent: (() => {
        const cmContent = document.querySelector(".cm-content");
        if (!cmContent) return null;
        const cs = getComputedStyle(cmContent);
        return {
          offsetWidth: cmContent.offsetWidth,
          offsetHeight: cmContent.offsetHeight,
          display: cs.display,
          textPreview: cmContent.textContent?.slice(0, 60) ?? "",
          lineCount: cmContent.querySelectorAll(".cm-line").length,
        };
      })(),
      page1Svg: page1Svg
        ? {
            outerWidth: page1Svg.getBoundingClientRect().width,
            outerHeight: page1Svg.getBoundingClientRect().height,
            attrs: {
              width: page1Svg.getAttribute("width"),
              height: page1Svg.getAttribute("height"),
              viewBox: page1Svg.getAttribute("viewBox"),
            },
            cssWidth: getComputedStyle(page1Svg).width,
            cssHeight: getComputedStyle(page1Svg).height,
            childCount: page1Svg.children.length,
            childTags: Array.from(page1Svg.children).map((c) => c.tagName),
            outerHTMLSize: page1Svg.outerHTML.length,
            pathCount: page1Svg.querySelectorAll("path").length,
            textCount: page1Svg.querySelectorAll("text").length,
            useCount: page1Svg.querySelectorAll("use").length,
            gCount: page1Svg.querySelectorAll("g").length,
          }
        : null,
    };
  }, label);
}

async function ensureOut() {
  try { await mkdir(OUT_DIR, { recursive: true }); } catch {}
}

async function main() {
  await ensureOut();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(tauriStub, { sample: SAMPLE, initialPath: INITIAL_PATH, realSvg: REAL_SVG });
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning") {
      console.log(`[${t}]`, m.text());
    }
  });
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));

  await page.goto(APP_URL);
  // Wait for the editor element to exist (not necessarily visible — reading
  // mode for .typ hides it).
  await page.waitForSelector(".cm-editor", { state: "attached", timeout: 10_000 });
  // Wait for first compile to land a page.
  await page.waitForSelector(".preview-pane-body .typst-page svg", { timeout: 10_000 }).catch(() => {});
  // Give layout one more tick.
  await page.waitForTimeout(400);

  // Force the sidebar visible (it auto-hides on docs with no headings,
  // which sample.typ is — but the user has it open in their screenshots).
  // The visibility-controlling code path doesn't expose a function, so we
  // strip the "hidden" class directly. This is a debugging hack only.
  await page.evaluate(() => {
    const aside = document.querySelector(".viewer-toc");
    if (aside) aside.classList.remove("hidden");
  });
  await page.waitForTimeout(100);

  const reading1 = await captureLayout(page, "initial-reading");
  await page.screenshot({ path: resolve(OUT_DIR, "1-initial-reading.png"), fullPage: false });

  // Toggle to edit via the toolbar/titlebar toggle button.
  // In reading-typst the modeToggle has aria-pressed='true' (reading is the
  // "pressed" state); clicking it should drop into edit.
  const modeToggle = page
    .locator('.viewer-toolbar-btn[aria-label*="mode" i], .viewer-titlebar-btn[aria-label*="mode" i], button[title*="mode" i]')
    .first();
  let toggleStrategy = "by-aria-label";
  if ((await modeToggle.count()) === 0) {
    toggleStrategy = "by-position-first";
    // Fallback: first toolbar button (the mode toggle on macOS titlebar).
    await page.locator(".viewer-titlebar-btn, .viewer-toolbar-btn").first().click();
  } else {
    await modeToggle.click();
  }
  await page.waitForTimeout(500);
  const edit1 = await captureLayout(page, `after-toggle-${toggleStrategy}`);
  await page.screenshot({ path: resolve(OUT_DIR, "2-after-toggle-to-edit.png"), fullPage: false });

  // Cmd-Shift-L should toggle the sidebar.
  const sidebarHiddenBefore = await page.evaluate(() =>
    document.querySelector(".viewer-toc")?.classList.contains("hidden"),
  );
  await page.keyboard.press("Meta+Shift+L");
  await page.waitForTimeout(200);
  const sidebarHiddenAfter = await page.evaluate(() =>
    document.querySelector(".viewer-toc")?.classList.contains("hidden"),
  );
  if (sidebarHiddenBefore === sidebarHiddenAfter) {
    console.log("⚠️  Cmd-Shift-L did NOT toggle sidebar (still", sidebarHiddenAfter, ")");
  } else {
    console.log("✅ Cmd-Shift-L toggled sidebar:", sidebarHiddenBefore, "→", sidebarHiddenAfter);
  }
  // Toggle it back.
  await page.keyboard.press("Meta+Shift+L");
  await page.waitForTimeout(200);

  // Toggle back to reading via the same button.
  if ((await modeToggle.count()) > 0) {
    await modeToggle.click();
  } else {
    await page.locator(".viewer-titlebar-btn, .viewer-toolbar-btn").first().click();
  }
  await page.waitForTimeout(500);
  const reading2 = await captureLayout(page, "after-toggle-back-to-reading");
  await page.screenshot({ path: resolve(OUT_DIR, "5-back-to-reading.png"), fullPage: false });

  const report = { reading1, edit1, reading2 };
  await writeFile(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));

  await browser.close();

  // Compact summary to stdout.
  for (const [label, snap] of Object.entries(report)) {
    console.log(`\n=== ${label.toUpperCase()} MODE ===`);
    console.log("html dataset:", snap.htmlDataset);
    console.log("shell:", snap.shellClass, "display=" + snap.shellDisplay);
    console.log("shell children:");
    for (const c of snap.shellChildren) {
      console.log(`  ${c.tag}.${c.class || "<none>"}  display=${c.display}  ${c.offsetWidth}x${c.offsetHeight}`);
    }
    if (snap.page1Svg) {
      console.log("svg page:", snap.page1Svg);
    } else {
      console.log("svg page: NONE");
    }
    console.log("pane body html (first 200 chars):", snap.paneBodyHTML);
  }
  console.log(`\nFull report: ${resolve(OUT_DIR, "report.json")}`);
  console.log(`Screenshots: ${OUT_DIR}/reading.png, ${OUT_DIR}/edit.png`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
