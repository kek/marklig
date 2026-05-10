import { createEditor, setMode } from "./editor/editor";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { mountTocSidebar, type TocSidebarHandle, type TocEntry } from "./ui/sidebar/toc";
import { mountFolderSidebar, type FolderSidebarHandle } from "./ui/sidebar/folder";
import { shouldShowSidebar, recordExplicitToggle } from "./ui/sidebar/toc-state";
import { buildDecorationField, refreshDecorationsEffect } from "./editor/decorations";
import { readingKeymap, editKeymap, setModeToggleHandler, setSaveHandler, setZoomHandlers, setSidebarToggleHandler, installZoomKeyHandler } from "./editor/keymaps";
import { zoomBy as zoomByFn, zoomReset as zoomResetFn } from "./editor/zoom";
import type { Mode } from "./editor/editor";
import { mountToolbar, computeDocStats } from "./ui/toolbar";
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
import { loadSettings, subscribeSettings, getAutoSave } from "./shell/settings";
import { restoreWindowState, installWindowStatePersistence } from "./shell/window-state";
import { openPreferences } from "./ui/preferences";
import { openKeyboardShortcuts } from "./ui/shortcuts";
import { t } from "./i18n/strings";
import "katex/dist/katex.min.css";
import {
  applyTheme,
  loadStoredTheme,
  watchSystemTheme,
} from "./editor/theme";
import { readDoc, openFileViaDialog, saveDoc, saveHtmlExport, saveMarkdownAs, revealInFileManager as fsReveal, pickFolder, isDirectory, type OpenedDoc } from "./shell/files";
import { message } from "@tauri-apps/plugin-dialog";
import { getValue, setValue } from "./shell/store";
import { buildHtmlExport } from "./export/html";
import { createDirtyTracker } from "./shell/dirty";
import { installCloseHandler } from "./shell/close";
import { installWatcher, type WatcherHandle } from "./shell/watcher";
import { promptReconcile, showOrphanNotice, showReloadedNotice } from "./ui/reconcile";
import { recordRecent } from "./shell/recents";
import { startRecoveryLoop, readAllRecovery, clearRecovery } from "./shell/recovery";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
  // Restore size + position before any other work so the user doesn't see
  // a default-sized window flash before the resize lands.
  await restoreWindowState();
  installWindowStatePersistence();

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

  // Recovery flow runs in the main window only. Secondary windows (File ->
  // New Window) are blank slates — they don't ask about restoring, and the
  // first/main window owns the recovery decision for the session.
  if (isMainWindow()) await maybeRestoreFromRecovery();

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

  // Forward-declared so the folder sidebar (mounted now) can call into
  // openWithDirtyPrompt (defined further down). Filled in once the helper
  // is actually available.
  let onFolderItemActivate: (path: string) => Promise<void> = async () => {};

  // Mount the folder sidebar INSIDE the same aside, above the TOC's "Contents"
  // heading. Hidden until the user opens a folder.
  const folder: FolderSidebarHandle = mountFolderSidebar({
    parent: toc.element,
    insertBefore: toc.element.firstElementChild as HTMLElement | undefined,
    onActivate: (path) => { void onFolderItemActivate(path); },
  });

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
    initialSidebarVisible: toc.isVisible(),
    onModeChange: (m) => {
      currentMode = m;
      document.documentElement.dataset.mode = m;
    },
    onSidebarToggle: () => {
      const next = !toc.isVisible();
      toc.setVisible(next);
      recordExplicitToggle(next);
      toolbar.setSidebarVisible(next);
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
  const stopZoomKeys = installZoomKeyHandler();
  window.addEventListener("beforeunload", () => stopZoomKeys());

  setSidebarToggleHandler(() => {
    const next = !toc.isVisible();
    toc.setVisible(next);
    recordExplicitToggle(next);
    toolbar.setSidebarVisible(next);
  });

  let currentPath: string | null = initialDoc?.path ?? null;
  if (currentPath) await recordRecent(currentPath);

  /** Open `root` as the current folder: persist it, list .md files in the
   * sidebar, ensure the sidebar is visible. Pass null to clear. */
  async function setCurrentFolder(root: string | null): Promise<void> {
    await setValue("currentFolder", root);
    await folder.setFolder(root);
    if (root) {
      // Make sure the user can actually see the panel.
      if (!toc.isVisible()) {
        toc.setVisible(true);
        recordExplicitToggle(true);
        toolbar.setSidebarVisible(true);
      }
      folder.setActiveFile(currentPath);
    }
  }

  // Restore the last-opened folder (if any) so the file list is right where
  // the user left it. Failures (folder moved/deleted/permission-denied) are
  // silent — currentFolder stays null and the panel stays hidden.
  void (async () => {
    const stored = await getValue<string | null>("currentFolder");
    if (typeof stored === "string" && stored.length > 0) {
      try {
        await setCurrentFolder(stored);
      } catch {
        await setValue("currentFolder", null);
      }
    }
  })();
  let watcherHandle: WatcherHandle | null = null;
  let diverged = false;
  const dirtyTracker = createDirtyTracker(view);
  // Auto-save debounce: each dirty notification resets a 1-second timer;
  // if it fires while still dirty (and a path is set), trigger a save.
  // Clearing/resaving is harmless when auto-save is off because the
  // subscriber checks getAutoSave() at fire time.
  const AUTO_SAVE_DELAY_MS = 1000;
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelAutoSave = (): void => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
  };
  const unsubDirty = dirtyTracker.subscribe(async (dirty) => {
    toolbar.setDirty(dirty);
    toolbar.setPath(currentPath);
    await setWindowTitle(currentPath, dirty);
    cancelAutoSave();
    // Skip auto-save when the file has diverged (external change since
    // last load) — triggerSave would pop a 'save anyway?' modal mid-
    // typing, which is the opposite of what auto-save should feel like.
    // Wait for the user to explicitly resolve the conflict.
    if (dirty && getAutoSave() && currentPath && !diverged) {
      autoSaveTimer = setTimeout(() => {
        if (dirtyTracker.isDirty() && currentPath && !diverged) {
          void triggerSave();
        }
      }, AUTO_SAVE_DELAY_MS);
    }
  });
  window.addEventListener("beforeunload", () => {
    unsubDirty();
    cancelAutoSave();
  });

  const stopRecovery = startRecoveryLoop({
    intervalMs: 5000,
    isDirty: () => dirtyTracker.isDirty(),
    currentPath: () => currentPath,
    currentContents: () => view.state.doc.toString(),
  });
  window.addEventListener("beforeunload", () => stopRecovery());

  // Refresh the TOC only when the document content actually changes — the
  // previous rAF-driven poll re-stringified the entire doc 60×/sec, which
  // costs O(N) per frame for large files and races the decoration recompute.
  // EditorView.updateListener fires once per transaction with a precomputed
  // docChanged flag. Same hook also drives the toolbar word-count readout.
  // Installed via a Compartment because listeners can't be added after
  // construction.
  const tocUpdateCompartment = new Compartment();
  const refreshStats = (): void => {
    toolbar.setStats(computeDocStats(view.state.doc.toString()));
  };
  refreshStats();
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      tocUpdateCompartment.of(
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          toc.refresh();
          refreshStats();
        }),
      ),
    ),
  });

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
    toolbar.setPath(currentPath);
    folder.setActiveFile(currentPath);
    if (currentPath) {
      await recordRecent(currentPath);
      await startWatching(currentPath);
    }
  }

  /** Prompt-on-dirty wrapper used by all out-of-band open paths
   * (drag-drop, OS file-association launches, "Open Recent", folder-tree click). */
  async function openWithDirtyPrompt(path: string): Promise<void> {
    if (dirtyTracker.isDirty()) {
      const proceed = await ask(
        t("dirty.body"),
        {
          title: t("dirty.title"),
          okLabel: t("dirty.discard"),
          cancelLabel: t("dirty.cancel"),
        },
      );
      if (!proceed) return;
    }
    await loadAndApplyDoc(path);
  }
  onFolderItemActivate = openWithDirtyPrompt;

  await buildAndAttachMenu({
    openFile: async () => {
      const doc = await openFileViaDialog();
      if (doc) await loadAndApplyDoc(doc.path);
    },
    openFolder: async () => {
      const root = await pickFolder();
      if (root) await setCurrentFolder(root);
    },
    newWindow: async () => { await spawnNewWindow(); },
    saveFile: () => { void triggerSave(); },
    saveFileAs: async () => {
      const defaultName = exportFileNameFromPath(currentPath, "md");
      const dest = await saveMarkdownAs(view.state.doc.toString(), defaultName);
      if (!dest) return;
      // Re-bind: dest becomes the new currentPath. Future Save writes here,
      // the watcher tracks the new file, and this open counts as recent.
      currentPath = dest;
      dirtyTracker.reset();
      diverged = false;
      await setWindowTitle(currentPath, false);
      toolbar.setPath(currentPath);
      await recordRecent(dest);
      await startWatching(dest);
      folder.setActiveFile(dest);
    },
    revealInFileManager: async () => {
      if (!currentPath) {
        await message("This document hasn't been saved yet.", { title: "Reveal in Finder" });
        return;
      }
      try {
        await fsReveal(currentPath);
      } catch (err) {
        await message(`Could not reveal: ${String(err instanceof Error ? err.message : err)}`, { title: "Reveal in Finder" });
      }
    },
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
      toolbar.setSidebarVisible(next);
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
    openPreferences: async () => {
      await openPreferences();
    },
    showKeyboardShortcuts: () => { void openKeyboardShortcuts(); },
  });

  // Settings change from any source (prefs UI, future Tauri-store sync) →
  // refresh the decoration field so widgets that read settings at toDOM time
  // (notably ImageWidget honoring remote-image policy) pick up the new value
  // without needing a document reload.
  const unsubSettings = subscribeSettings(() => {
    view.dispatch({ effects: refreshDecorationsEffect.of() });
  });
  window.addEventListener("beforeunload", () => unsubSettings());

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
        toolbar.setPath(null);
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
    const paths = event.payload.paths;
    if (paths.length === 0) return;

    // Single-path drop: if it's a directory, open it as a folder. Otherwise
    // fall through to the multi-file routing below (which handles single .md
    // and multi-.md drops uniformly).
    if (paths.length === 1 && (await isDirectory(paths[0]))) {
      await setCurrentFolder(paths[0]);
      return;
    }

    const mdFiles = paths.filter((p) => /\.(md|markdown|mdx|mdown)$/i.test(p));
    if (mdFiles.length === 0) return;

    // First .md goes to the current window. Any additional ones spawn new
    // windows pre-loaded with their respective files — so dragging five
    // .md files yields five windows, each on its own document.
    await openWithDirtyPrompt(mdFiles[0]);
    for (let i = 1; i < mdFiles.length; i++) {
      await spawnNewWindow(mdFiles[i]);
    }
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
  // Secondary windows opened with ?file=… (drop-onto-window splits a multi-
  // file drop across windows) load that file directly.
  const urlFile = fileFromUrlQuery();
  if (urlFile) {
    try {
      return await readDoc(urlFile);
    } catch {
      // Fall through if the path can't be read; window stays blank.
    }
  }

  // Other secondary windows (plain File -> New Window) start blank — the user
  // opens a file explicitly. Avoids two windows fighting over the same restore
  // flow and avoids surprising side effects (re-opening last file in a brand-
  // new window).
  if (!isMainWindow()) return null;

  if (recoveredDoc) return recoveredDoc;
  const argPath = await firstMarkdownArg();
  if (argPath) return await readDoc(argPath);
  // macOS file-association launches deliver the path via RunEvent::Opened,
  // which can fire after bootstrap starts. Wait briefly for it before
  // falling back to last-opened or the open dialog — otherwise double-
  // clicking a .md in Finder briefly shows a redundant open dialog
  // before the doc loads.
  const launched = await waitForFileOpenRequest(500);
  if (launched) return await readDoc(launched);
  // Re-open whatever was open last time the app closed (recents[0] is the
  // most-recently-opened path, written on every successful open via
  // recordRecent). Falls through to the dialog if the file is gone.
  const lastOpened = await tryReopenLastFile();
  if (lastOpened) return lastOpened;
  return await openFileViaDialog();
}

async function tryReopenLastFile(): Promise<OpenedDoc | null> {
  try {
    const recents = await loadRecents();
    if (recents.length === 0) return null;
    return await readDoc(recents[0]);
  } catch {
    // File missing/moved/permission-denied — silently fall through to dialog.
    return null;
  }
}

async function waitForFileOpenRequest(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let unlisten: (() => void) | null = null;
    const timer = setTimeout(() => {
      unlisten?.();
      resolve(null);
    }, timeoutMs);
    void listen<string[]>("file-open-request", (e) => {
      const paths = Array.isArray(e.payload) ? e.payload : [];
      const md = paths.find((p) => /\.(md|markdown|mdx|mdown)$/i.test(p));
      if (!md) return;
      clearTimeout(timer);
      unlisten?.();
      resolve(md);
    }).then((u) => {
      unlisten = u;
    });
  });
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

let nextWindowSeq = 2;

/** Open a new app window. Without `initialFile`, the new window starts as an
 * empty blank slate — the user opens via dialog or drag-drop. With one, the
 * path is forwarded as a `?file=…` query param that bootstrap reads in place
 * of the usual recovery / last-opened resolution. */
async function spawnNewWindow(initialFile?: string): Promise<void> {
  // Find the next free 'window-N' label. Existing windows may be labeled
  // 'main', 'window-2', 'window-3', etc.; reuse-or-skip until we find a free one.
  let label = `window-${nextWindowSeq++}`;
  while (await WebviewWindow.getByLabel(label)) {
    label = `window-${nextWindowSeq++}`;
  }
  const url = initialFile
    ? `/?file=${encodeURIComponent(initialFile)}`
    : "/";
  const win = new WebviewWindow(label, {
    title: "Viewer",
    width: 1000,
    height: 760,
    minWidth: 480,
    minHeight: 320,
    dragDropEnabled: true,
    url,
  });
  win.once("tauri://error", (e) => {
    console.error("failed to create window", label, e);
  });
}

function fileFromUrlQuery(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const f = params.get("file");
    return f && f.length > 0 ? f : null;
  } catch {
    return null;
  }
}

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
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
