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
import { graphvizProducer, graphvizCache, graphvizCacheEffect } from "./editor/decorations/graphviz";
import { loadSettings, subscribeSettings, getAutoSave } from "./shell/settings";
import { restoreWindowState, installWindowStatePersistence } from "./shell/window-state";
import {
  loadWindowSession,
  clearWindowSession,
  installWindowSessionPersistence,
  type WindowSessionEntry,
  type WindowMode,
} from "./shell/window-session";
import { openPreferences } from "./ui/preferences";
import { openKeyboardShortcuts } from "./ui/shortcuts";
import { openProjectPalette } from "./ui/project-palette";
import { openQuickOpenPalette } from "./ui/quick-open";
import { t } from "./i18n/strings";
import "katex/dist/katex.min.css";
import {
  applyTheme,
  loadStoredTheme,
  watchSystemTheme,
} from "./editor/theme";
import { readDoc, openFileViaDialog, saveDoc, saveHtmlExport, saveMarkdownAs, revealInFileManager as fsReveal, pickFolder, isDirectory, resolveFolderRoot, type OpenedDoc } from "./shell/files";
import { message } from "@tauri-apps/plugin-dialog";
import { getValue, setValue } from "./shell/store";
import { buildHtmlExport } from "./export/html";
import { createDirtyTracker } from "./shell/dirty";
import { installCloseHandler } from "./shell/close";
import { installWatcher, type WatcherHandle } from "./shell/watcher";
import { installFolderWatcher, type FolderWatcherHandle } from "./shell/folder-watcher";
import { promptReconcile, showOrphanNotice, showReloadedNotice } from "./ui/reconcile";
import { recordRecent } from "./shell/recents";
import { startRecoveryLoop, readAllRecovery, clearRecovery } from "./shell/recovery";
import { getFilePosition, setFilePosition, canonicalizePath } from "./shell/file-positions";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen, emit, emitTo } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { buildAndAttachMenu } from "./shell/menus";
import {
  installMenuActionListener,
  dispatchToFocused,
  dispatchToAll,
  type LocalMenuHandlers,
} from "./shell/menu-actions";
import { setActiveTheme } from "./editor/theme";
import { loadRecents, clearRecents } from "./shell/recents";
import {
  loadRecentProjects,
  recordRecentProject,
  clearRecentProjects,
} from "./shell/recent-projects";
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

  // Multi-window restore: on the main window, read the persisted session,
  // spawn one secondary window per non-main entry, then clear the session so
  // a future single-window launch doesn't keep resurrecting old windows. The
  // main window's own entry is consumed below to influence which file/scroll
  // position/mode this window opens with.
  const sessionEntryForThisWindow = await loadAndApplySession();

  // Restored session entry for the main window only takes effect when the
  // higher-priority sources (recovery, file-association launch, CLI arg)
  // didn't yield a doc; otherwise those win.
  const sessionFallbackPath =
    isMainWindow() && sessionEntryForThisWindow?.path
      ? sessionEntryForThisWindow.path
      : null;
  // Secondary windows that were spawned from a session entry receive their
  // path via ?file=… (see resolveInitialDoc) — same channel as multi-file
  // drag-drop, so we don't need a separate code path.
  const initialDoc = await resolveInitialDoc(sessionFallbackPath);

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
  const readingProducers = [...editingProducers, readingWidgetsProducer, mathProducer, mermaidProducer, graphvizProducer];

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
    initialDocumentPath: initialDoc?.path ?? null,
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
    schedulePositionSave();
  }, { passive: true });

  // ── Per-file scroll/cursor persistence ───────────────────────────────────
  // Debounce settings-store writes: scrolling fires many events per second;
  // each `setFilePosition` reads + writes the entire map and saves the JSON
  // file, so we batch up to one write per ~500ms of idle.
  const POSITION_SAVE_DEBOUNCE_MS = 500;
  let positionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  // After a doc-load, ignore the synthetic scroll events that fire while
  // decorations inflate the height (Shiki/Mermaid placeholders → real nodes).
  // The restore path arms this; the next user scroll past
  // `positionSaveSuppressedUntil` re-enables saves.
  let positionSaveSuppressedUntil = 0;

  function suppressPositionSave(forMs: number): void {
    positionSaveSuppressedUntil = Date.now() + forMs;
  }

  function captureCurrentPosition(): { scrollTop: number; line: number; col: number } {
    const scrollTop = view.scrollDOM.scrollTop;
    const head = view.state.selection.main.head;
    const lineObj = view.state.doc.lineAt(head);
    return {
      scrollTop,
      line: lineObj.number,
      col: head - lineObj.from,
    };
  }

  async function persistCurrentPosition(): Promise<void> {
    if (!currentPath) return;
    if (Date.now() < positionSaveSuppressedUntil) return;
    try {
      const key = await canonicalizePath(currentPath);
      await setFilePosition(key, captureCurrentPosition());
    } catch {
      // Best-effort — storage failures shouldn't break editing.
    }
  }

  function schedulePositionSave(): void {
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => {
      positionSaveTimer = null;
      void persistCurrentPosition();
    }, POSITION_SAVE_DEBOUNCE_MS);
  }

  function flushPositionSaveSync(): void {
    // beforeunload runs synchronously; we kick off the promise but can't await
    // it. Tauri's @tauri-apps/plugin-store flushes on a debounced background
    // task and survives normal app exit; if the renderer is killed mid-flight
    // we lose at most the trailing edit, which is acceptable for cursor
    // position (recovery is the load-bearing path).
    if (positionSaveTimer) {
      clearTimeout(positionSaveTimer);
      positionSaveTimer = null;
    }
    void persistCurrentPosition();
  }
  window.addEventListener("beforeunload", flushPositionSaveSync);

  // Restore the saved position once the doc is loaded and decorations have
  // had a chance to settle. We schedule across two requestAnimationFrames:
  // 1) decoration field is committed at the end of the current frame after
  //    the change/refresh dispatch; 2) the next rAF gives the layout pass
  //    time to flush. Async widget caches (Shiki / Mermaid) re-fire the
  //    decoration field as their results arrive, so we re-apply the scroll
  //    until either the user interacts (any wheel/keydown/pointerdown) or
  //    a short watchdog window elapses — without that, a cold-cache
  //    Shiki render lands AFTER our restore and pushes content down.
  function restorePosition(target: { scrollTop: number; line: number; col: number }): void {
    suppressPositionSave(2500);
    let userInteracted = false;
    const markInteraction = (): void => { userInteracted = true; };
    const interactionEvents: Array<keyof WindowEventMap> = ["wheel", "keydown", "pointerdown", "touchstart"];
    for (const ev of interactionEvents) {
      window.addEventListener(ev, markInteraction, { capture: true, once: true });
    }
    const cleanup = (): void => {
      for (const ev of interactionEvents) {
        window.removeEventListener(ev, markInteraction, true);
      }
    };

    // Best-effort cursor restore. Clamp to the current document size so a
    // remembered line past EOF doesn't blow up.
    try {
      const docLines = view.state.doc.lines;
      const targetLine = Math.max(1, Math.min(target.line || 1, docLines));
      const lineObj = view.state.doc.line(targetLine);
      const offset = Math.min(lineObj.from + Math.max(0, target.col), lineObj.to);
      view.dispatch({ selection: { anchor: offset, head: offset } });
    } catch {
      // Out-of-range or empty doc — skip cursor restore, scroll-only is fine.
    }

    let attempt = 0;
    const reapply = (): void => {
      if (userInteracted) { cleanup(); return; }
      view.scrollDOM.scrollTop = target.scrollTop;
      attempt++;
      // Re-apply for ~1.5s to ride out late Shiki/Mermaid inflation. Each
      // attempt waits one rAF; the loop self-stops on user interaction.
      if (attempt < 90) requestAnimationFrame(reapply);
      else cleanup();
    };
    requestAnimationFrame(() => requestAnimationFrame(reapply));
  }

  /** Apply a saved position right after a doc-load, unless the URL has an
   * explicit `#anchor` fragment (which the user / external link explicitly
   * asked us to honor). */
  async function maybeRestorePositionFor(path: string | null): Promise<void> {
    if (!path) return;
    if (window.location.hash && window.location.hash.length > 1) return;
    try {
      const key = await canonicalizePath(path);
      const saved = await getFilePosition(key);
      if (saved) restorePosition(saved);
    } catch {
      // best-effort
    }
  }

  const modeExtensions = {
    reading: { decorations: readingSet, keymap: readingKeymap },
    edit:    { decorations: editingSet, keymap: editKeymap },
  };

  // Restore mode + scroll position. Two sources, in priority order:
  //   1. URL query params (?mode=, ?scrollTop=) — set by spawnRestoredWindow
  //      for secondary windows. Per-window, doesn't depend on session lookup
  //      from inside the secondary window.
  //   2. Session entry for the current label — only relevant on the main
  //      window, since secondary windows always go via the URL channel.
  // If either is absent the defaults (reading mode, scrollTop 0) win.
  const urlRestore = restoreParamsFromUrl();
  const restoredMode: Mode =
    urlRestore.mode ?? sessionEntryForThisWindow?.mode ?? "reading";
  const restoredScrollTop: number =
    urlRestore.scrollTop ?? sessionEntryForThisWindow?.scrollTop ?? 0;

  let currentMode: Mode = restoredMode;

  const toolbar = mountToolbar(root, {
    view,
    modeExtensions,
    initialMode: restoredMode,
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

  // Apply the restored mode (toolbar reflects it but the editor compartments
  // need the explicit setMode to swap decorations + keymap + readOnly).
  if (restoredMode !== "reading") {
    setMode(view, restoredMode, modeExtensions[restoredMode]);
    document.documentElement.dataset.mode = restoredMode;
  }

  // Apply the restored scroll position after a frame so layout has settled.
  // Without the rAF, scrollTop is silently clamped to 0 because scrollHeight
  // hasn't been measured yet on a freshly-mounted EditorView.
  if (restoredScrollTop > 0) {
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = restoredScrollTop;
    });
  }

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
  // Per-window folder root, mirrored from the store so the periodic session
  // tick can read it synchronously. setCurrentFolder() below is the only
  // writer.
  let currentFolder: string | null = null;
  const selfLabel = getCurrentWindow().label;
  // Map<window label, current folder root>. Populated from broadcasts so the
  // main window can route Finder opens to a window already showing the same
  // tree. Only the main window consults this map.
  const folderByLabel = new Map<string, string | null>();
  let folderWatcherHandle: FolderWatcherHandle | null = null;
  if (currentPath) await recordRecent(currentPath);

  // Multi-window session restore: snapshot this window's state on a periodic
  // tick + on close. Captures path/scrollTop/mode/folder/sidebar so the next
  // launch can re-spawn the exact arrangement. Per-window — both main and
  // secondary windows participate. Closing one window of several drops just
  // that window from the next-launch set; Cmd-Q preserves all.
  const stopWindowSession = installWindowSessionPersistence({
    currentPath: () => currentPath,
    scrollTop: () => view.scrollDOM.scrollTop,
    mode: () => currentMode,
    folder: () => currentFolder,
    sidebarVisible: () => toc.isVisible(),
  });
  window.addEventListener("beforeunload", () => stopWindowSession());

  /** Open `root` as the current folder: persist it, list .md files in the
   * sidebar, ensure the sidebar is visible. Pass null to clear. */
  async function setCurrentFolder(root: string | null): Promise<void> {
    if (root === currentFolder) {
      // No-op if unchanged — just resync active highlight in case the file did.
      if (root) folder.setActiveFile(currentPath);
      return;
    }
    currentFolder = root;
    await setValue("currentFolder", root);
    await folder.setFolder(root);
    // Announce so the main window's routing map stays in sync. Loopback to
    // this window's own listener is harmless (same value).
    void emit("viewer:window-folder", { label: selfLabel, folder: root });
    if (root) await recordRecentProject(root);
    // Swap the recursive folder watcher: stop the old one (if any) and start
    // a new one for the new root. The watcher fires "viewer://folder-changed"
    // when files appear/disappear so we can refresh the sidebar tree.
    if (folderWatcherHandle) {
      await folderWatcherHandle.stop();
      folderWatcherHandle = null;
    }
    if (root) {
      try {
        folderWatcherHandle = await installFolderWatcher({
          root,
          onChanged: () => { void folder.refresh(); },
        });
      } catch (err) {
        console.warn("folder watcher failed to start", err);
      }
    }
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

  // Every window listens for a targeted open request; main routes here when
  // it has decided this window owns the file's folder. emitTo only delivers
  // to the named window, so other windows ignore by virtue of not receiving.
  const unsubTargetedOpen = await listen<string>("viewer:open-file", async (e) => {
    const md = typeof e.payload === "string" ? e.payload : null;
    if (!md) return;
    await openWithDirtyPrompt(md);
    await getCurrentWindow().setFocus();
  });
  window.addEventListener("beforeunload", () => unsubTargetedOpen());

  // Track other windows' folder roots (main only). Each window broadcasts on
  // every setCurrentFolder; close announcements clear stale entries (best-
  // effort — beforeunload may not always deliver, so we also verify the
  // window still exists at route time).
  if (isMainWindow()) {
    const unsubFolderState = await listen<{ label: string; folder: string | null }>(
      "viewer:window-folder",
      (e) => { folderByLabel.set(e.payload.label, e.payload.folder); },
    );
    const unsubWindowClosed = await listen<{ label: string }>(
      "viewer:window-closed",
      (e) => { folderByLabel.delete(e.payload.label); },
    );
    window.addEventListener("beforeunload", () => {
      unsubFolderState();
      unsubWindowClosed();
    });
  }
  // Announce this window's initial state (null until syncFolderToFile runs)
  // so the main window's map sees us even when we have no folder yet.
  void emit("viewer:window-folder", { label: selfLabel, folder: null });
  window.addEventListener("beforeunload", () => {
    void emit("viewer:window-closed", { label: selfLabel });
  });

  /** Derive the folder sidebar root from a file path on cold-start — the file's
   * repo (nearest .git/.jj/.hg/.svn ancestor) or its parent directory if no
   * repo is found. No-op once a folder is already open: subsequent file opens
   * never switch the sidebar root, even if the file lives elsewhere; the user
   * picks a project, files come and go. Best-effort — lookup failures are
   * swallowed. */
  async function syncFolderToFile(path: string): Promise<void> {
    if (currentFolder) return;
    try {
      const root = await resolveFolderRoot(path);
      if (root) await setCurrentFolder(root);
    } catch {
      // Ignore — keep whatever folder was already shown.
    }
  }

  // Initial folder: derive from the opened file if there is one; otherwise
  // restore from the per-window session entry (preferred) or the legacy
  // global `currentFolder` key (fallback for first-launch / new windows).
  if (currentPath) {
    void syncFolderToFile(currentPath);
  } else {
    void (async () => {
      let target: string | null | undefined = sessionEntryForThisWindow?.folder;
      if (target === undefined) {
        target = await getValue<string | null>("currentFolder");
      }
      if (typeof target === "string" && target.length > 0) {
        try {
          await setCurrentFolder(target);
        } catch {
          // Folder moved / deleted / permission-denied — clear the global
          // key so we don’t keep retrying it, and leave the panel hidden.
          await setValue("currentFolder", null);
        }
      }
      // If the session entry explicitly stored `sidebarVisible: false`,
      // honour that even when setCurrentFolder() would have opened the panel.
      if (sessionEntryForThisWindow?.sidebarVisible === false) {
        toc.setVisible(false);
        recordExplicitToggle(false);
        toolbar.setSidebarVisible(false);
      }
    })();
  }
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
    // Capture the OUTGOING file's position before we replace the buffer so
    // tab-switching / Open-Recent doesn't lose where the user was.
    if (currentPath) {
      try {
        const prevKey = await canonicalizePath(currentPath);
        await setFilePosition(prevKey, captureCurrentPosition());
      } catch {
        // best-effort
      }
    }
    const doc = await readDoc(path);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc.source },
    });
    currentPath = doc.path;
    dirtyTracker.reset();
    diverged = false;
    await setWindowTitle(currentPath, false);
    toolbar.setPath(currentPath);
    toc.setDocumentTitle(currentPath);
    folder.setActiveFile(currentPath);
    if (currentPath) {
      await recordRecent(currentPath);
      await startWatching(currentPath);
      await maybeRestorePositionFor(currentPath);
      await syncFolderToFile(currentPath);
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

  // Per-window menu handlers. The Tauri app menu fires its callbacks in
  // whichever webview last set it (typically main), so without routing each
  // action would run against that window's state regardless of focus. We
  // install these as a listener in every window and have the menu dispatch
  // the action to the focused window via emitTo. Theme is broadcast to all
  // windows so light/dark stays in sync.
  const localHandlers: LocalMenuHandlers = {
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
      toc.setDocumentTitle(currentPath);
      await recordRecent(dest);
      await startWatching(dest);
      folder.setActiveFile(dest);
      await syncFolderToFile(dest);
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
    openProject: async (path) => { await setCurrentFolder(path); },
    clearRecentProjects: async () => { await clearRecentProjects(); },
    openProjectPalette: () => { void openProjectPalette(); },
    quickOpen: () => { void openQuickOpenPalette(currentFolder); },
  };
  const unsubMenuActions = await installMenuActionListener(localHandlers);
  window.addEventListener("beforeunload", () => unsubMenuActions());

  // Global Ctrl+R → project switcher (issue #27). Literal Ctrl on every
  // platform — Cmd+R stays free for reload. preventDefault keeps the webview
  // from navigating. Guarded so we don't steal R-as-a-letter inside text
  // inputs (CodeMirror normally eats keystrokes before this runs, but
  // defensively skip when focus is in any editable surface).
  function onGlobalKey(e: KeyboardEvent): void {
    if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key !== "r" && e.key !== "R") return;
    const t = e.target as HTMLElement | null;
    if (t) {
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
    }
    e.preventDefault();
    void openProjectPalette();
  }
  document.addEventListener("keydown", onGlobalKey, true);
  window.addEventListener("beforeunload", () => {
    document.removeEventListener("keydown", onGlobalKey, true);
  });

  // Per-window Cmd-P binding. The app menu accelerator (main window only)
  // also fires this via dispatchToFocused, but a same-window keydown handler
  // is more reliable when focus is deep inside CodeMirror and avoids any
  // round-trip through Tauri's event bus. The palette should open even from
  // inside the editor (CodeMirror doesn't bind Mod-p in its keymaps), but
  // not while a non-editor <input>/<textarea> has focus — e.g. the sidebar's
  // filter box, where the user is mid-typing and Cmd-P could feel intrusive.
  const onQuickOpenKey = (e: KeyboardEvent): void => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.altKey || e.shiftKey) return;
    if (e.key !== "p" && e.key !== "P") return;
    const target = e.target as HTMLElement | null;
    if (target && isPlainEditableInput(target)) return;
    e.preventDefault();
    e.stopPropagation();
    localHandlers.quickOpen();
  };
  window.addEventListener("keydown", onQuickOpenKey, true);
  window.addEventListener("beforeunload", () => {
    window.removeEventListener("keydown", onQuickOpenKey, true);
  });


  // Only the main window owns the app menu. If every window installed it
  // each one would clobber the previous handlers (last writer wins on
  // macOS), which is exactly what produced the "Cmd-W closes the most
  // recently opened window" bug. With one owner, routing via emitTo to
  // the focused window is deterministic.
  if (isMainWindow()) {
    await buildAndAttachMenu({
      openFile: () => dispatchToFocused({ type: "openFile" }),
      openFolder: () => dispatchToFocused({ type: "openFolder" }),
      newWindow: () => dispatchToFocused({ type: "newWindow" }),
      saveFile: () => { void dispatchToFocused({ type: "saveFile" }); },
      saveFileAs: () => dispatchToFocused({ type: "saveFileAs" }),
      revealInFileManager: () => dispatchToFocused({ type: "revealInFileManager" }),
      closeWindow: async () => {
        // The Tauri menu is owned by the main window's JS context, so any
        // action callback runs there — `getCurrentWindow()` would always
        // return main regardless of which window has focus. Route Cmd-W to
        // the truly focused window so it closes the frontmost one (and its
        // close-requested handler runs the dirty prompt for its own doc).
        const focused = (await Window.getFocusedWindow()) ?? getCurrentWindow();
        await focused.close();
      },
      toggleMode: () => { void dispatchToFocused({ type: "toggleMode" }); },
      toggleSidebar: () => { void dispatchToFocused({ type: "toggleSidebar" }); },
      // Theme changes apply app-wide; broadcast so every window updates in
      // lockstep instead of just the focused one.
      setTheme: (theme) => { void dispatchToAll({ type: "setTheme", theme }); },
      zoomIn: () => { void dispatchToFocused({ type: "zoomIn" }); },
      zoomOut: () => { void dispatchToFocused({ type: "zoomOut" }); },
      zoomReset: () => { void dispatchToFocused({ type: "zoomReset" }); },
      openFind: () => { void dispatchToFocused({ type: "openFind" }); },
      openReplace: () => { void dispatchToFocused({ type: "openReplace" }); },
      recents: async () => await loadRecents(),
      openRecent: (path) => dispatchToFocused({ type: "openRecent", path }),
      clearRecents: () => dispatchToFocused({ type: "clearRecents" }),
      exportHtml: () => dispatchToFocused({ type: "exportHtml" }),
      printDocument: () => { void dispatchToFocused({ type: "printDocument" }); },
      copyAsHtml: () => dispatchToFocused({ type: "copyAsHtml" }),
      openPreferences: () => dispatchToFocused({ type: "openPreferences" }),
      showKeyboardShortcuts: () => { void dispatchToFocused({ type: "showKeyboardShortcuts" }); },
      recentProjects: async () => await loadRecentProjects(),
      openProject: (path) => dispatchToFocused({ type: "openProject", path }),
      clearRecentProjects: () => dispatchToFocused({ type: "clearRecentProjects" }),
      openProjectPalette: () => dispatchToFocused({ type: "openProjectPalette" }),
      quickOpen: () => { void dispatchToFocused({ type: "quickOpen" }); },
      installCliTool: async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        try {
          const path = await invoke<string>("install_cli_tool");
          await message(
            `Installed at ${path}.\n\nUsage:\n  md              — open Märklig\n  md <file.md>    — open a Markdown file\n  md <directory>  — open a folder`,
            { title: "Command Line Tool" },
          );
        } catch (err) {
          const msg = String(err);
          if (msg === "cancelled") return;
          await message(`Could not install: ${msg}`, { title: "Command Line Tool", kind: "error" });
        }
      },
    });
  }
  window.addEventListener("beforeunload", () => {
    if (folderWatcherHandle) void folderWatcherHandle.stop();
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
        toc.setDocumentTitle(null);
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

  // Restore the saved scroll/cursor for the initial doc. Skipped when the
  // initial doc was supplied by crash recovery (the recovered buffer is
  // newer than the on-disk version, so its prior scroll position is stale)
  // and skipped when an explicit URL hash is present.
  if (currentPath && !recoveredDoc) {
    await maybeRestorePositionFor(currentPath);
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
  // The Rust side forwards the paths as `file-open-request`; only the main
  // window decides what to do (the emit broadcasts to every window, so without
  // this gate each window would react independently). Routing:
  //   1. Resolve the file's folder root.
  //   2. If any existing window already shows that root, hand the file off
  //      there via emitTo + focus.
  //   3. Otherwise spawn a new window pre-loaded with the file.
  // Cold-launch is unrelated: the very first window's bootstrap consumes the
  // event via waitForFileOpenRequest and loads it into itself.
  const unsubFileOpen = await listen<string[]>("file-open-request", async (e) => {
    if (!isMainWindow()) return;
    const paths = Array.isArray(e.payload) ? e.payload : [];
    // `md <directory>` (and Finder "Open With…" on a folder) deliver a single
    // directory path. Treat that the same as the drag-drop directory case:
    // route to an existing window already showing it, or set folder root.
    if (paths.length === 1 && (await isDirectory(paths[0]))) {
      const dir = paths[0];
      let matchedLabel: string | null = null;
      for (const [label, folder] of folderByLabel) {
        if (folder !== dir) continue;
        const w = await WebviewWindow.getByLabel(label);
        if (w) { matchedLabel = label; break; }
        folderByLabel.delete(label);
      }
      if (matchedLabel) {
        if (matchedLabel !== selfLabel) {
          const w = await WebviewWindow.getByLabel(matchedLabel);
          await w?.setFocus();
        }
      } else {
        await dispatchToFocused({ type: "openProject", path: dir });
      }
      return;
    }
    const md = paths.find((p) => /\.(md|markdown|mdx|mdown)$/i.test(p));
    if (!md) return;
    let targetRoot: string | null = null;
    try { targetRoot = await resolveFolderRoot(md); } catch { /* fall through */ }
    let matchedLabel: string | null = null;
    if (targetRoot) {
      for (const [label, folder] of folderByLabel) {
        if (folder !== targetRoot) continue;
        // The map can lag a closed window by a frame; verify before routing.
        const w = await WebviewWindow.getByLabel(label);
        if (w) { matchedLabel = label; break; }
        folderByLabel.delete(label);
      }
    }
    if (matchedLabel) {
      await emitTo(matchedLabel, "viewer:open-file", md);
      if (matchedLabel !== selfLabel) {
        const w = await WebviewWindow.getByLabel(matchedLabel);
        await w?.setFocus();
      }
    } else {
      await spawnNewWindow(md);
    }
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

  const unsubscribeGraphviz = graphvizCache.subscribe(() => {
    view.dispatch({ effects: graphvizCacheEffect.of() });
  });
  window.addEventListener("beforeunload", () => unsubscribeGraphviz());

}

async function resolveInitialDoc(sessionFallbackPath: string | null = null): Promise<OpenedDoc | null> {
  // Secondary windows opened with ?file=… (drop-onto-window splits a multi-
  // file drop across windows, and multi-window session restore reuses the
  // same channel) load that file directly.
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
  // Multi-window session restore for the main window: prefer the file the
  // main window had open last time over generic recents[0], so closing-
  // and-reopening preserves the exact arrangement. Falls through to recents
  // if the file is gone.
  if (sessionFallbackPath) {
    try {
      return await readDoc(sessionFallbackPath);
    } catch {
      // file missing/moved — fall through to recents/dialog
    }
  }
  // Re-open whatever was open last time the app closed (recents[0] is the
  // most-recently-opened path, written on every successful open via
  // recordRecent). Falls through to the dialog if the file is gone.
  const lastOpened = await tryReopenLastFile();
  if (lastOpened) return lastOpened;
  return await openFileViaDialog();
}

/**
 * On the main window only: read the persisted multi-window session, spawn
 * secondary windows for each non-main entry whose file still exists, then
 * clear the session list (so a future single-window launch doesn't keep
 * resurrecting old windows). Returns the session entry for the *current*
 * window so the caller can use it to influence file/scroll/mode restore.
 *
 * The set of entries on disk is implicitly the "alive set at last quit":
 * each individual close removes its own entry (window-session.ts close
 * handler), while Cmd-Q on macOS bypasses per-window close events entirely
 * — leaving the periodic-tick entries intact. So whatever's still in the
 * store when we boot up is exactly what to restore.
 *
 * Secondary windows: returns their own session entry if any (they may have
 * been re-spawned by main and want to honor scrollTop/mode from URL params,
 * but we still surface the entry for symmetry).
 */
async function loadAndApplySession(): Promise<WindowSessionEntry | null> {
  const session = await loadWindowSession();
  const myLabel = currentWindowLabel();
  const myEntry = session.windows.find((w) => w.label === myLabel) ?? null;

  if (!isMainWindow()) return myEntry;

  // Spawn secondary windows from the persisted session. If a previously-open
  // file no longer exists, skip that window silently — we don't want a modal
  // storm on launch.
  for (const entry of session.windows) {
    if (entry.label === myLabel) continue;
    if (entry.path && !(await pathExists(entry.path))) continue;
    await spawnRestoredWindow(entry);
  }

  // One-shot: clear the session now so we don't restore the same set on the
  // next launch (the windows we just spawned will write their own fresh
  // entries on close). Crash recovery for unsaved buffers stays in its own
  // store and is unaffected.
  await clearWindowSession();
  return myEntry;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("path_exists", { path });
  } catch {
    return false;
  }
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
  const label = await nextWindowLabel();
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

/** Reopen a window from a persisted session entry. Honors the entry's label
 * (so the next session-record happens under the same name and overwrites
 * cleanly), restores logical size/position, and forwards file/scrollTop/mode
 * via URL params for the secondary window's bootstrap to apply. */
async function spawnRestoredWindow(entry: WindowSessionEntry): Promise<void> {
  // Don't collide with a window the user already opened in this session.
  // (Shouldn't normally happen on launch — the main window is the only one
  //  alive — but defensive in case the session contains a 'main' duplicate.)
  if (await WebviewWindow.getByLabel(entry.label)) return;

  const params = new URLSearchParams();
  if (entry.path) params.set("file", entry.path);
  params.set("scrollTop", String(Math.max(0, Math.round(entry.scrollTop))));
  params.set("mode", entry.mode);
  const url = `/?${params.toString()}`;

  // Sanity-clamp obviously-broken sizes; let valid logical pixels through
  // verbatim so multi-monitor positions reproduce.
  const width = entry.width >= 320 ? entry.width : 1000;
  const height = entry.height >= 240 ? entry.height : 760;

  const win = new WebviewWindow(entry.label, {
    title: "Viewer",
    x: entry.x,
    y: entry.y,
    width,
    height,
    minWidth: 480,
    minHeight: 320,
    dragDropEnabled: true,
    url,
  });
  win.once("tauri://error", (e) => {
    console.error("failed to restore window", entry.label, e);
  });
  // Bump the seq so the next File -> New Window doesn't collide with a
  // restored 'window-N'. nextWindowSeq is monotonic; treat any restored
  // numeric label as a lower bound.
  const m = /^window-(\d+)$/.exec(entry.label);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= nextWindowSeq) nextWindowSeq = n + 1;
  }
}

async function nextWindowLabel(): Promise<string> {
  // Find the next free 'window-N' label. Existing windows may be labeled
  // 'main', 'window-2', 'window-3', etc.; reuse-or-skip until we find a free one.
  let label = `window-${nextWindowSeq++}`;
  while (await WebviewWindow.getByLabel(label)) {
    label = `window-${nextWindowSeq++}`;
  }
  return label;
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

/** Read optional ?mode= and ?scrollTop= URL params used by multi-window
 *  session restore to forward state into a freshly-spawned secondary window.
 *  Either may be absent; both are validated. */
function restoreParamsFromUrl(): { mode: WindowMode | null; scrollTop: number | null } {
  try {
    const params = new URLSearchParams(window.location.search);
    const m = params.get("mode");
    const mode: WindowMode | null = m === "edit" || m === "reading" ? m : null;
    const sRaw = params.get("scrollTop");
    let scrollTop: number | null = null;
    if (sRaw != null) {
      const n = Number(sRaw);
      if (Number.isFinite(n) && n >= 0) scrollTop = n;
    }
    return { mode, scrollTop };
  } catch {
    return { mode: null, scrollTop: null };
  }
}

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

function defaultPlaceholder(): string {
  return "# Welcome to Viewer\n\nNo document opened. Use **File → Open** in Plan 3 once the menu lands.\n";
}

/** True when the element is a non-editor text input the user is plausibly
 * typing into (sidebar filter, find panel, etc.). The CodeMirror editor is
 * a contenteditable inside `.cm-content`, which we intentionally exclude so
 * Cmd-P opens the palette from reading/edit mode alike. */
function isPlainEditableInput(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // Stay out of other contenteditables that aren't CodeMirror's content.
  if (el.isContentEditable && !el.closest(".cm-content")) return true;
  return false;
}

bootstrap().catch((err) => {
  console.error("bootstrap failed", err);
  const root = document.getElementById("root");
  if (root) {
    root.textContent = `Failed to start: ${String(err)}`;
  }
});
