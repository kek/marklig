import { createEditor, setMode } from "./editor/editor";
import { EditorView } from "@codemirror/view";
import { mountTocSidebar, type TocSidebarHandle, type TocEntry } from "./ui/sidebar/toc";
import { shouldShowSidebar, recordExplicitToggle } from "./ui/sidebar/toc-state";
import { buildDecorationField } from "./editor/decorations";
import { readingKeymap, editKeymap, setModeToggleHandler, setSaveHandler, setZoomHandlers, setSidebarToggleHandler } from "./editor/keymaps";
import { zoomBy as zoomByFn, zoomReset as zoomResetFn } from "./editor/zoom";
import type { Mode } from "./editor/editor";
import { mountToolbar } from "./ui/toolbar";
import { setWindowTitle } from "./ui/titlebar";
import { headingsProducer } from "./editor/decorations/headings";
import { inlineProducer } from "./editor/decorations/inline";
import { listsProducer } from "./editor/decorations/lists";
import { linksProducer } from "./editor/decorations/links";
import { imagesProducer } from "./editor/decorations/images";
import { blockquotesProducer } from "./editor/decorations/blockquotes";
import { tablesProducer } from "./editor/decorations/tables";
import { codeblocksProducer, primeHighlighter, highlightCache, highlightCacheEffect } from "./editor/decorations/codeblocks";
import { frontmatterProducer } from "./editor/decorations/frontmatter";
import { footnotesProducer } from "./editor/decorations/footnotes";
import { readingWidgetsProducer } from "./editor/decorations/reading-widgets";
import { mathProducer } from "./editor/decorations/math";
import { mermaidProducer, mermaidCache, mermaidCacheEffect } from "./editor/decorations/mermaid";
import { loadSettings } from "./shell/settings";
import "katex/dist/katex.min.css";
import {
  applyTheme,
  loadStoredTheme,
  watchSystemTheme,
} from "./editor/theme";
import { readDoc, openFileViaDialog, saveDoc, saveHtmlExport, type OpenedDoc } from "./shell/files";
import { buildHtmlExport } from "./export/html";
import { createDirtyTracker } from "./shell/dirty";
import { installCloseHandler } from "./shell/close";
import { installWatcher, type WatcherHandle } from "./shell/watcher";
import { promptReconcile, showOrphanNotice, showReloadedNotice } from "./ui/reconcile";
import { recordRecent } from "./shell/recents";
import { startRecoveryLoop, readAllRecovery, clearRecovery } from "./shell/recovery";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { buildAndAttachMenu } from "./shell/menus";
import { setActiveTheme } from "./editor/theme";
import { loadRecents, clearRecents } from "./shell/recents";
import { openSearchPanel } from "@codemirror/search";

let recoveredDoc: { path: string; source: string } | null = null;

async function bootstrap(): Promise<void> {
  applyTheme(loadStoredTheme());
  watchSystemTheme(() => applyTheme(loadStoredTheme()));
  await loadSettings();

  await primeHighlighter([
    "javascript", "typescript", "python", "go", "rust",
    "java", "c", "cpp", "shell", "json", "yaml", "sql",
    "html", "css", "markdown",
  ]);

  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  root.innerHTML = "";

  async function maybeRestoreFromRecovery(): Promise<void> {
    const entries = await readAllRecovery();
    if (entries.length === 0) return;
    const entry = entries[0];
    const restore = await ask(
      `Restore unsaved changes to ${entry.originalPath}?`,
      { title: "Recover unsaved work", okLabel: "Restore", cancelLabel: "Discard" },
    );
    if (restore) {
      recoveredDoc = { path: entry.originalPath, source: entry.contents };
    }
    await clearRecovery(entry.originalPath);
  }

  await maybeRestoreFromRecovery();

  const initialDoc = await resolveInitialDoc();

  const shell = document.createElement("div");
  shell.className = "viewer-app-shell";
  root.append(shell);

  const view = createEditor({
    parent: shell,
    source: initialDoc?.source ?? defaultPlaceholder(),
  });

  const editingProducers = [
    headingsProducer,
    inlineProducer,
    listsProducer,
    linksProducer,
    imagesProducer,
    blockquotesProducer,
    tablesProducer,
    codeblocksProducer,
    frontmatterProducer,
    footnotesProducer,
  ];
  const readingProducers = [...editingProducers, readingWidgetsProducer, mathProducer, mermaidProducer];

  const editingSet = buildDecorationField(editingProducers);
  const readingSet = buildDecorationField(readingProducers);

  setMode(view, "reading", { decorations: readingSet, keymap: readingKeymap });
  document.documentElement.dataset.mode = "reading";

  function countHeadings(source: string): number {
    return (source.match(/^#{1,6} /gm) ?? []).length;
  }

  function jumpTo(offset: number): void {
    view.dispatch({
      selection: { anchor: offset, head: offset },
      effects: EditorView.scrollIntoView(offset, { y: "start" }),
    });
    view.focus();
  }

  const initialHeadings = countHeadings(view.state.doc.toString());
  const initialTocPath = initialDoc?.path ?? "";
  const toc: TocSidebarHandle = mountTocSidebar({
    view,
    parent: shell,
    initiallyVisible: shouldShowSidebar(initialTocPath, initialHeadings),
    onActivate: (entry: TocEntry) => jumpTo(entry.from),
  });

  // Make the sidebar appear LEFT of the editor — insert before the editor's DOM.
  shell.insertBefore(toc.element, view.dom);

  // Scroll-sync: highlight the entry whose heading is at or above the topmost visible offset.
  view.scrollDOM.addEventListener("scroll", () => {
    const rect = view.scrollDOM.getBoundingClientRect();
    const offset = view.posAtCoords({ x: rect.left + 10, y: rect.top + 10 });
    if (offset !== null) toc.setActive(offset);
  }, { passive: true });

  const modeExtensions = {
    reading: { decorations: readingSet, keymap: readingKeymap },
    edit:    { decorations: editingSet, keymap: editKeymap },
  };

  let currentMode: Mode = "reading";

  const toolbar = mountToolbar(root, {
    view,
    modeExtensions,
    initialMode: "reading",
    onModeChange: (m) => {
      currentMode = m;
      document.documentElement.dataset.mode = m;
    },
    onSidebarToggle: () => {
      const next = !toc.isVisible();
      toc.setVisible(next);
      recordExplicitToggle(next);
    },
  });

  setModeToggleHandler(() => {
    currentMode = currentMode === "reading" ? "edit" : "reading";
    setMode(view, currentMode, modeExtensions[currentMode]);
    toolbar.setMode(currentMode);
    document.documentElement.dataset.mode = currentMode;
  });

  setZoomHandlers({
    in: () => zoomByFn(view, +1),
    out: () => zoomByFn(view, -1),
    reset: () => zoomResetFn(view),
  });

  setSidebarToggleHandler(() => {
    const next = !toc.isVisible();
    toc.setVisible(next);
    recordExplicitToggle(next);
  });

  let currentPath: string | null = initialDoc?.path ?? null;
  if (currentPath) await recordRecent(currentPath);
  let watcherHandle: WatcherHandle | null = null;
  let diverged = false;
  const dirtyTracker = createDirtyTracker(view);
  const unsubDirty = dirtyTracker.subscribe(async (dirty) => {
    toolbar.setDirty(dirty);
    await setWindowTitle(currentPath, dirty);
  });
  window.addEventListener("beforeunload", () => unsubDirty());

  const stopRecovery = startRecoveryLoop({
    intervalMs: 5000,
    isDirty: () => dirtyTracker.isDirty(),
    currentPath: () => currentPath,
    currentContents: () => view.state.doc.toString(),
  });
  window.addEventListener("beforeunload", () => stopRecovery());

  let lastSourceForToc = view.state.doc.toString();
  function pollTocRefresh(): void {
    const cur = view.state.doc.toString();
    if (cur !== lastSourceForToc) {
      lastSourceForToc = cur;
      toc.refresh();
    }
    requestAnimationFrame(pollTocRefresh);
  }
  requestAnimationFrame(pollTocRefresh);

  const triggerSave = async (): Promise<void> => {
    if (!currentPath) return;
    if (diverged) {
      const proceed = await ask(
        "Saving will overwrite the changes that were made on disk.",
        {
          title: "Diverged",
          okLabel: "Save anyway",
          cancelLabel: "Cancel",
        },
      );
      if (!proceed) return;
    }
    if (watcherHandle) await watcherHandle.markSelfWrite();
    try {
      await saveDoc(currentPath, view.state.doc.toString());
      dirtyTracker.reset();
      diverged = false;
      await clearRecovery(currentPath);
    } catch (err) {
      console.error("save failed", err);
    }
  };
  setSaveHandler(() => { void triggerSave(); });

  const stopCloseHandler = await installCloseHandler({
    isDirty: () => dirtyTracker.isDirty(),
    save: async () => {
      if (!currentPath) throw new Error("No path to save to");
      await saveDoc(currentPath, view.state.doc.toString());
      dirtyTracker.reset();
    },
  });
  window.addEventListener("beforeunload", () => stopCloseHandler());

  async function loadAndApplyDoc(path: string): Promise<void> {
    const doc = await readDoc(path);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc.source },
    });
    currentPath = doc.path;
    dirtyTracker.reset();
    diverged = false;
    await setWindowTitle(currentPath, false);
    if (currentPath) {
      await recordRecent(currentPath);
      await startWatching(currentPath);
    }
  }

  /** Prompt-on-dirty wrapper used by all out-of-band open paths
   * (drag-drop, OS file-association launches, "Open Recent"). */
  async function openWithDirtyPrompt(path: string): Promise<void> {
    if (dirtyTracker.isDirty()) {
      const proceed = await ask(
        "Discard your unsaved changes and open this file?",
        {
          title: "Unsaved changes",
          okLabel: "Discard and open",
          cancelLabel: "Cancel",
        },
      );
      if (!proceed) return;
    }
    await loadAndApplyDoc(path);
  }

  await buildAndAttachMenu({
    openFile: async () => {
      const doc = await openFileViaDialog();
      if (doc) await loadAndApplyDoc(doc.path);
    },
    saveFile: () => { void triggerSave(); },
    closeWindow: async () => {
      const win = getCurrentWindow();
      await win.close();
    },
    toggleMode: () => {
      currentMode = currentMode === "reading" ? "edit" : "reading";
      setMode(view, currentMode, modeExtensions[currentMode]);
      toolbar.setMode(currentMode);
      document.documentElement.dataset.mode = currentMode;
    },
    toggleSidebar: () => {
      const next = !toc.isVisible();
      toc.setVisible(next);
      recordExplicitToggle(next);
    },
    setTheme: (t) => setActiveTheme(t),
    zoomIn: () => zoomByFn(view, +1),
    zoomOut: () => zoomByFn(view, -1),
    zoomReset: () => zoomResetFn(view),
    openFind: () => { openSearchPanel(view); },
    openReplace: () => { openSearchPanel(view); },
    recents: async () => await loadRecents(),
    openRecent: async (path) => { await loadAndApplyDoc(path); },
    clearRecents: async () => { await clearRecents(); },
    exportHtml: async () => {
      const html = await buildHtmlExport(view.state.doc.toString(), {
        title: documentTitleFromPath(currentPath),
      });
      const defaultName = exportFileNameFromPath(currentPath, "html");
      await saveHtmlExport(html, defaultName);
    },
    printDocument: () => {
      void (async () => {
        const html = await buildHtmlExport(view.state.doc.toString(), {
          title: documentTitleFromPath(currentPath),
        });
        openPrintWindow(html);
      })();
    },
    copyAsHtml: async () => {
      const html = await buildHtmlExport(view.state.doc.toString(), {
        title: documentTitleFromPath(currentPath),
      });
      await writeClipboardHtml(html);
    },
  });

  async function startWatching(path: string): Promise<void> {
    if (watcherHandle) {
      await watcherHandle.stop();
      watcherHandle = null;
    }
    watcherHandle = await installWatcher({
      path,
      async onModified() {
        if (dirtyTracker.isDirty()) {
          const choice = await promptReconcile();
          if (choice === "reload") {
            await reloadFromDisk();
          } else {
            diverged = true;
          }
        } else {
          await reloadFromDisk();
          showReloadedNotice();
        }
      },
      onRemoved() {
        showOrphanNotice();
        currentPath = null;
        void setWindowTitle(null, true);
      },
    });
  }

  async function reloadFromDisk(): Promise<void> {
    if (!currentPath) return;
    const doc = await readDoc(currentPath);
    const savedScrollTop = view.scrollDOM.scrollTop;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc.source },
    });
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = savedScrollTop;
    });
    dirtyTracker.reset();
    diverged = false;
  }

  if (currentPath) {
    await startWatching(currentPath);
  }

  const dropWindow = getCurrentWindow();
  const unsubDrop = await dropWindow.onDragDropEvent(async (event) => {
    if (event.payload.type !== "drop") return;
    const md = event.payload.paths.find((p) => /\.(md|markdown|mdx|mdown)$/i.test(p));
    if (!md) return;
    await openWithDirtyPrompt(md);
  });
  window.addEventListener("beforeunload", () => unsubDrop());

  await setWindowTitle(initialDoc?.path ?? null, false);

  // OS file-association launches (double-click a .md, "Open With…", drag-drop
  // onto the dock/taskbar) deliver the path via Tauri's RunEvent::Opened.
  // The Rust side forwards the paths as `file-open-request`; pick the first
  // markdown one and route through the dirty-prompt wrapper.
  const unsubFileOpen = await listen<string[]>("file-open-request", async (e) => {
    const paths = Array.isArray(e.payload) ? e.payload : [];
    const md = paths.find((p) => /\.(md|markdown|mdx|mdown)$/i.test(p));
    if (!md) return;
    await openWithDirtyPrompt(md);
  });
  window.addEventListener("beforeunload", () => unsubFileOpen());

  const unsubscribeHighlight = highlightCache.subscribe(() => {
    view.dispatch({ effects: highlightCacheEffect.of() });
  });
  window.addEventListener("beforeunload", () => unsubscribeHighlight());

  const unsubscribeMermaid = mermaidCache.subscribe(() => {
    view.dispatch({ effects: mermaidCacheEffect.of() });
  });
  window.addEventListener("beforeunload", () => unsubscribeMermaid());
}

async function resolveInitialDoc(): Promise<OpenedDoc | null> {
  if (recoveredDoc) return recoveredDoc;
  const argPath = await firstMarkdownArg();
  if (argPath) return await readDoc(argPath);
  return await openFileViaDialog();
}

async function firstMarkdownArg(): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const argv = await invoke<string[]>("plugin:cli|argv").catch(() => null);
    if (!argv) return null;
    return argv.find((a) => /\.(md|markdown|mdx|mdown)$/i.test(a)) ?? null;
  } catch {
    return null;
  }
}

function documentTitleFromPath(path: string | null): string {
  if (!path) return "Markdown export";
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(md|markdown|mdx|mdown)$/i, "");
}

function exportFileNameFromPath(path: string | null, ext: string): string {
  return `${documentTitleFromPath(path)}.${ext}`;
}

function openPrintWindow(html: string): void {
  // Same-process iframe — Tauri's webview doesn't reliably forward window.print()
  // from a popup, but a same-document iframe.contentWindow.print() does. The
  // iframe is removed after the print dialog closes.
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.append(frame);
  const doc = frame.contentDocument;
  if (!doc) { frame.remove(); return; }
  doc.open();
  doc.write(html);
  doc.close();
  const cleanup = () => {
    frame.contentWindow?.removeEventListener("afterprint", cleanup);
    frame.remove();
  };
  // Fonts/CSS need a tick to apply before print measures layout.
  requestAnimationFrame(() => {
    frame.contentWindow?.addEventListener("afterprint", cleanup);
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  });
}

async function writeClipboardHtml(html: string): Promise<void> {
  // Modern clipboard API: write both text/html and a plain-text fallback.
  // Some receivers (terminals, plain-text editors) only consume text/plain.
  const plain = stripTags(html);
  const item = new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([plain], { type: "text/plain" }),
  });
  await navigator.clipboard.write([item]);
}

function stripTags(html: string): string {
  const tmp = document.createElement("template");
  tmp.innerHTML = html;
  return tmp.content.textContent ?? "";
}

function defaultPlaceholder(): string {
  return "# Welcome to Viewer\n\nNo document opened. Use **File → Open** in Plan 3 once the menu lands.\n";
}

bootstrap().catch((err) => {
  console.error("bootstrap failed", err);
  const root = document.getElementById("root");
  if (root) {
    root.textContent = `Failed to start: ${String(err)}`;
  }
});
