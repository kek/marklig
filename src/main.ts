import { createEditor, setMode } from "./editor/editor";
import { EditorView } from "@codemirror/view";
import { mountTocSidebar, type TocSidebarHandle, type TocEntry } from "./ui/sidebar/toc";
import { shouldShowSidebar, recordExplicitToggle } from "./ui/sidebar/toc-state";
import { buildDecorationField } from "./editor/decorations";
import { readingKeymap, editKeymap, setModeToggleHandler, setSaveHandler } from "./editor/keymaps";
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
import {
  applyTheme,
  loadStoredTheme,
  watchSystemTheme,
} from "./editor/theme";
import { readDoc, openFileViaDialog, saveDoc, type OpenedDoc } from "./shell/files";
import { createDirtyTracker } from "./shell/dirty";
import { installCloseHandler } from "./shell/close";
import { installWatcher, type WatcherHandle } from "./shell/watcher";
import { promptReconcile, showOrphanNotice, showReloadedNotice } from "./ui/reconcile";
import { recordRecent } from "./shell/recents";
import { startRecoveryLoop, readAllRecovery, clearRecovery } from "./shell/recovery";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { buildAndAttachMenu } from "./shell/menus";
import { setActiveTheme } from "./editor/theme";
import { loadRecents, clearRecents } from "./shell/recents";
import { openSearchPanel } from "@codemirror/search";

let recoveredDoc: { path: string; source: string } | null = null;

async function bootstrap(): Promise<void> {
  applyTheme(loadStoredTheme());
  watchSystemTheme(() => applyTheme(loadStoredTheme()));

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
  const readingProducers = [...editingProducers, readingWidgetsProducer];

  const editingSet = buildDecorationField(editingProducers);
  const readingSet = buildDecorationField(readingProducers);

  setMode(view, "reading", { decorations: readingSet, keymap: readingKeymap });

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
    onModeChange: (m) => { currentMode = m; },
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
    },
    toggleSidebar: () => {
      const next = !toc.isVisible();
      toc.setVisible(next);
      recordExplicitToggle(next);
    },
    setTheme: (t) => setActiveTheme(t),
    zoomIn: () => { /* Task 20 wires this */ },
    zoomOut: () => { /* Task 20 wires this */ },
    zoomReset: () => { /* Task 20 wires this */ },
    openFind: () => { openSearchPanel(view); },
    openReplace: () => { openSearchPanel(view); },
    recents: async () => await loadRecents(),
    openRecent: async (path) => { await loadAndApplyDoc(path); },
    clearRecents: async () => { await clearRecents(); },
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
    const dropped = event.payload.paths;
    const md = dropped.find((p) => /\.(md|markdown|mdx|mdown)$/i.test(p));
    if (!md) return;

    if (dirtyTracker.isDirty()) {
      const proceed = await ask(
        "Discard your unsaved changes and open the dropped file?",
        {
          title: "Unsaved changes",
          okLabel: "Discard and open",
          cancelLabel: "Cancel",
        },
      );
      if (!proceed) return;
    }

    const doc = await readDoc(md);
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
  });
  window.addEventListener("beforeunload", () => unsubDrop());

  await setWindowTitle(initialDoc?.path ?? null, false);

  const unsubscribeHighlight = highlightCache.subscribe(() => {
    view.dispatch({ effects: highlightCacheEffect.of() });
  });
  window.addEventListener("beforeunload", () => unsubscribeHighlight());
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
