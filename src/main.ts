import { createEditor, setMode } from "./editor/editor";
import { isSupportedExtension } from "./format";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  linkClickExtension,
  buildAnchorIndex,
  type LinkClickHandlers,
} from "./editor/link-clicks";
import { openUrl as openExternalUrl } from "@tauri-apps/plugin-opener";
import { mountTocSidebar, type TocSidebarHandle, type TocEntry } from "./ui/sidebar/toc";
import { mountFolderSidebar, type FolderSidebarHandle } from "./ui/sidebar/folder";
import { shouldShowSidebar, recordExplicitToggle } from "./ui/sidebar/toc-state";
import { buildDecorationField, refreshDecorationsEffect } from "./editor/decorations";
import { readingKeymap, editKeymap, setModeToggleHandler, setSaveHandler, setZoomHandlers, installZoomKeyHandler, setAltZoomRoute } from "./editor/keymaps";
import { zoomBy as zoomByFn, zoomReset as zoomResetFn } from "./editor/zoom";
import type { Mode } from "./editor/editor";
import { mountToolbar, computeDocStats } from "./ui/toolbar";
import { setWindowTitle, mountTitlebar, isMacPlatform, applyPlatformClass } from "./ui/titlebar";
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
import { lineNamesProducer } from "./editor/decorations/line-names";
import { loadSettings, subscribeSettings, getAutoSave, getPreviewPaneWidth, setPreviewPaneWidth, getTypstZoom, adjustTypstZoom, resetTypstZoom } from "./shell/settings";
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
import { mountContextMenu } from "./ui/context-menu";
import { t, tA11y } from "./i18n/strings";
import "katex/dist/katex.min.css";
import {
  applyTheme,
  loadStoredTheme,
  watchSystemTheme,
} from "./editor/theme";
import { readDoc, openFileViaDialog, saveDoc, saveHtmlExport, saveMarkdownAs, saveTypstAs, revealInFileManager as fsReveal, pickFolder, isDirectory, resolveFolderRoot, type OpenedDoc } from "./shell/files";
import { message } from "@tauri-apps/plugin-dialog";
import { getValue, setValue } from "./shell/store";
import { buildHtmlExport } from "./export/html";
import { createDirtyTracker } from "./shell/dirty";
import { installCloseHandler } from "./shell/close";
import { installWatcher, type WatcherHandle } from "./shell/watcher";
import { installFolderWatcher, type FolderWatcherHandle } from "./shell/folder-watcher";
import { promptReconcile, showOrphanNotice, showReloadedNotice } from "./ui/reconcile";
import { recordRecent } from "./shell/recents";
import {
  startRecoveryLoop,
  readAllRecovery,
  clearRecovery,
  resolveRecoveryAction,
} from "./shell/recovery";
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
import { loadRecents, clearRecents, renameRecent } from "./shell/recents";
import {
  loadRecentProjects,
  recordRecentProject,
  clearRecentProjects,
} from "./shell/recent-projects";
import {
  recordFileInProject,
  forgetFileInProject,
} from "./shell/project-recents";
import { resolveProjectFallbackFile } from "./shell/project-fallback";
import { decideProjectRoute, dedupeSessionByFolder } from "./shell/project-routing";
import { openSearchPanel } from "@codemirror/search";
import { detectFormat } from "./format";
import { mountPreviewPane, type PreviewPaneHandle } from "./ui/preview-pane";
import { mountPreviewSplitter } from "./ui/preview-splitter";
import { typstFormat } from "./format/typst";
import { createTypstDriver, type TypstDriver, type CompileResult } from "./format/typst-driver";
import { typstDiagnosticsExtension, setTypstDiagnostics } from "./editor/typst-diagnostics";

/** Crash-recovery dump that survived the previous session, paired with the
 * file's current on-disk content. When set, bootstrap loads `source` into the
 * buffer (so the user sees their unsaved edits) and seeds the dirty tracker
 * against `diskBaseline` so the dirty dot lights up — equivalent to "I edited
 * this file and crashed before save". */
let recoveredDoc: { path: string; source: string; diskBaseline: string } | null = null;

async function bootstrap(): Promise<void> {
  // Tag <html> with the platform class before any UI mounts — CSS rules for
  // the overlay titlebar / legacy toolbar branch on `.platform-macos`.
  applyPlatformClass();
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
    // Silent recovery: with force-save-on-quit (#115) and silent window
    // restore (#116) shipped, a clean quit leaves no dump worth asking about,
    // and any dump that does survive is by definition from a crash. Asking
    // "restore?" only forces the user to weigh in on something they can't
    // actually evaluate from a one-line modal. Instead:
    //   1. dump differs from disk -> load dump into buffer, mark dirty so the
    //      user lands in a window with their last edits + dirty dot lit;
    //      they can save or revert from there.
    //   2. dump matches disk -> nothing was lost; drop the dump silently.
    //   3. file gone from disk -> still load the dump (mark dirty against an
    //      empty baseline); the user can save it back wherever they want.
    // Either way the dump is cleared after a single boot — if we hit a second
    // crash before the user saves, the 5 s recovery loop will write a fresh
    // dump from the now-restored buffer.
    const entries = await readAllRecovery();
    const action = await resolveRecoveryAction(entries, async (path) => {
      try {
        const doc = await readDoc(path);
        return doc.source;
      } catch {
        // File missing / unreadable — null tells the resolver to treat the
        // dump as differing (and load it against an empty baseline).
        return null;
      }
    });
    if (action.kind === "none") return;
    if (action.kind === "load") {
      recoveredDoc = {
        path: action.path,
        source: action.source,
        diskBaseline: action.diskBaseline,
      };
    }
    // Both "match" and "load" exhaust the dump in one boot — if a second
    // crash happens before save, the 5 s loop writes a fresh one.
    await clearRecovery(action.path);
  }

  // Recovery runs in the main window only. Secondary windows (File ->
  // New Window) are blank slates — they don't participate in the recovery
  // store, and the first/main window owns the silent restore decision.
  if (isMainWindow()) await maybeRestoreFromRecovery();

  // Multi-window restore: on the main window, read the persisted session,
  // spawn one secondary window per non-main entry, then clear the session so
  // a future single-window launch doesn't keep resurrecting old windows. The
  // main window's own entry is consumed below to influence which file/scroll
  // position/mode this window opens with.
  const sessionEntryForThisWindow = await loadAndApplySession();

  // Restored session entry for the main window only takes effect when the
  // higher-priority sources (recovery, file-association launch, CLI arg)
  // didn't yield a doc; otherwise those win. We also pass the persisted
  // folder so the restore-time fallback chain (per-project last file →
  // root README → welcome) can run when the file the project pointed at
  // is gone or the entry is from a pre-#122 session where the recorded
  // file belonged to a *different* project than the recorded folder.
  const sessionFallbackPath =
    isMainWindow() && sessionEntryForThisWindow?.path
      ? sessionEntryForThisWindow.path
      : null;
  const sessionFallbackFolder =
    isMainWindow() && sessionEntryForThisWindow?.folder
      ? sessionEntryForThisWindow.folder
      : null;
  // Secondary windows that were spawned from a session entry receive their
  // path via ?file=… (see resolveInitial) — same channel as multi-file
  // drag-drop, so we don't need a separate code path.
  const { doc: initialDoc, folder: initialFolder } = await resolveInitial(
    sessionFallbackPath,
    sessionFallbackFolder,
  );

  const shell = document.createElement("div");
  shell.className = "viewer-app-shell";
  root.append(shell);

  const view = createEditor({
    parent: shell,
    source: initialDoc?.source ?? defaultPlaceholder(),
  });

  // Subscribe to the async widget caches *immediately* after the view exists,
  // before any `await` below. The editor's first decoration compute (on the
  // initial doc) fires Shiki / Mermaid / Graphviz requests synchronously during
  // bootstrap; their results land via a microtask at the next await. If these
  // subscriptions were registered later (after the many awaited Tauri-IPC calls
  // in bootstrap), that first cache-fill would notify an empty listener set and
  // the "re-render with highlights" dispatch would be lost — leaving code blocks
  // unhighlighted on load until the user typed or toggled mode. Registering here
  // guarantees a subscriber is present before any compute resolves.
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

  // Preview pane + splitter. Appended after the editor so they sit to the right.
  const previewPane: PreviewPaneHandle = mountPreviewPane({ parent: shell });

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
    // Per-line view-transition-names; must run after the others so its line
    // decorations (which carry the style attribute) sort last and win the
    // attribute merge on lines that already have a heading/blockquote line
    // decoration.
    lineNamesProducer,
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
    onCreate: async (absPath) => {
      // The watcher will eventually re-list the folder, but kick the in-process
      // refresh so the new file shows up immediately — and route through the
      // same open path used by tree clicks so all the usual side-effects fire
      // (recents, watcher, position restore). After the file is open, force
      // edit mode: the file already exists on disk by this point (we just
      // wrote it), so the isNew → auto-edit branch in loadAndApplyDoc doesn't
      // fire. A freshly-created empty file always wants the editor focused.
      await folder.refresh();
      await onFolderItemActivate(absPath);
      if (currentMode !== "edit") {
        currentMode = "edit";
        setMode(view, "edit", modeExtensions.edit);
        toolbar.setMode("edit");
        document.documentElement.dataset.mode = "edit";
      }
    },
    onRename: async (fromAbs, toAbs) => {
      // Refresh the tree immediately — the watcher's create+remove events
      // will arrive eventually but the user just acted, so we close the
      // visual gap.
      await folder.refresh();
      // If the renamed file is the currently-open one, re-target the
      // buffer's path and the per-file watcher so subsequent saves write
      // to the new path and external-change events for the new path
      // reach this window. The watcher mark-self-write suppresses any
      // delete event the rename fired from triggering the orphan flow.
      if (currentPath === fromAbs) {
        if (watcherHandle) {
          await watcherHandle.markSelfWrite();
          await watcherHandle.stop();
          watcherHandle = null;
        }
        currentPath = toAbs;
        await setWindowTitle(currentPath, dirtyTracker.isDirty(), currentFolder);
        toolbar.setPath(currentPath, currentFolder);
        toc.setDocumentTitle(currentPath);
        folder.setActiveFile(currentPath);
        await renameRecent(fromAbs, toAbs);
        await startWatching(currentPath);
      } else {
        // Not currently open — still keep recents tidy so subsequent
        // Open Recent doesn't point at a missing path.
        await renameRecent(fromAbs, toAbs);
      }
    },
    onDelete: async (_absPath) => {
      // The watcher's remove event drives the orphan flow when the
      // deleted file is the one currently open — we intentionally don't
      // add a second code path for that case (CLAUDE.md "match repo
      // style"). All we have to do is close the visual gap on the tree.
      await folder.refresh();
    },
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
  // A cold launch via `md newfile.md` lands here with initialDoc.isNew true.
  // Force edit mode so the user can start typing immediately; otherwise the
  // window opens in reading mode showing a blank document.
  const restoredMode: Mode = initialDoc?.isNew
    ? "edit"
    : (urlRestore.mode ?? sessionEntryForThisWindow?.mode ?? "reading");
  const restoredScrollTop: number =
    urlRestore.scrollTop ?? sessionEntryForThisWindow?.scrollTop ?? 0;

  let currentMode: Mode = restoredMode;

  // On macOS the overlay titlebar absorbs the edit toggle / TOC toggle /
  // file-name / stats — `mountTitlebar` returns the same ToolbarHandle shape
  // so the rest of bootstrap doesn't care which surface is in play. On
  // Windows/Linux the legacy toolbar stays; a custom titlebar there would
  // mean re-implementing min/max/close, which is out of scope for #46.
  const mountChrome = isMacPlatform() ? mountTitlebar : mountToolbar;
  const toolbar = mountChrome(root, {
    view,
    modeExtensions,
    initialMode: restoredMode,
    initialSidebarVisible: toc.isVisible(),
    onModeChange: (m) => {
      currentMode = m;
      document.documentElement.dataset.mode = m;
      // Reading-typst pins the pane open and may need a fresh compile so it
      // shows something. Edit-mode toggle leaves the pane state as-is.
      applyPreviewPaneLayout();
      // After the class change, the editor may have transitioned from
      // display:none (reading-typst) to display:flex (edit). CodeMirror's
      // ResizeObserver normally catches that, but WebKit can be slow to
      // notify on display flips — force a measure so the viewport and
      // gutter render immediately rather than after the next interaction.
      requestAnimationFrame(() => view.requestMeasure());
      if (m === "reading" && detectFormat(currentPath) === "typst") {
        scheduleTypstCompile();
      }
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
    // Same as onModeChange — reading-typst needs the pane visible and
    // populated. applyPreviewPaneLayout reads currentMode to force-open.
    applyPreviewPaneLayout();
    // Force a CM viewport measure: WebKit can lag on display:none → flex
    // transitions and the editor would otherwise render its content only
    // after the next interaction (scroll, click, resize).
    requestAnimationFrame(() => view.requestMeasure());
    if (currentMode === "reading" && detectFormat(currentPath) === "typst") {
      scheduleTypstCompile();
    }
  });

  setZoomHandlers({
    in: () => zoomByFn(view, +1),
    out: () => zoomByFn(view, -1),
    reset: () => zoomResetFn(view),
  });
  const stopZoomKeys = installZoomKeyHandler();
  window.addEventListener("beforeunload", () => stopZoomKeys());

  // Re-route Cmd-+/-/0 to the Typst preview pane when focus is inside it.
  // The editor zoom binding (above) stays the default for the editor itself.
  setAltZoomRoute({
    match: () => {
      if (detectFormat(currentPath) !== "typst") return false;
      const el = document.activeElement;
      return el !== null && !!(el.closest && el.closest(".preview-pane-body"));
    },
    in: () => {
      adjustTypstZoom(1);
      applyPreviewPaneLayout();
    },
    out: () => {
      adjustTypstZoom(-1);
      applyPreviewPaneLayout();
    },
    reset: () => {
      resetTypstZoom();
      applyPreviewPaneLayout();
    },
  });

  // toggleSidebar (Cmd-T) is wired via localHandlers below and the
  // window-level keydown handler. CM6 keymap is no longer involved.
  function toggleSidebar(): void {
    const next = !toc.isVisible();
    toc.setVisible(next);
    recordExplicitToggle(next);
    toolbar.setSidebarVisible(next);
  }

  let currentPath: string | null = initialDoc?.path ?? null;

  // Preview splitter — mounted to shell. The pane was appended earlier
  // (right after the editor), so we move the splitter into the right slot
  // and then re-append the pane so the final shell DOM order is
  // [sidebar, editor, splitter, pane] — matching the grid template
  // `auto 1fr auto var(--preview-pane-width)`.
  mountPreviewSplitter({
    parent: shell,
    container: shell,
    getFraction: () => getPreviewPaneWidth(),
    onResize: (frac) => {
      setPreviewPaneWidth(frac);
      applyPreviewPaneLayout();
    },
  });
  // Re-append moves the pane element to be the last child without
  // re-mounting it, putting it after the splitter in source order.
  shell.append(previewPane.element);

  function applyPreviewPaneLayout(): void {
    const format = detectFormat(currentPath);
    // In reading mode for .typ the pane is the only surface, so force it
    // open regardless of the per-format toggle (which still controls edit
    // mode's split). Markdown reading mode is decorated in-place and never
    // forces the pane open.
    const isTypst = format === "typst";
    const isReadingTypst = isTypst && currentMode === "reading";
    // Pane is .typ-only: edit mode = split, reading mode = pane full-width
    // with the source hidden. Markdown never gets a pane.
    shell.classList.toggle("preview-open", isTypst);
    shell.classList.toggle("typst-reading", isReadingTypst);
    previewPane.setVisible(isTypst);
    shell.style.setProperty(
      "--preview-pane-width",
      `${(getPreviewPaneWidth() * 100).toFixed(2)}%`,
    );
    // Push the current Typst zoom into the pane body's custom property
    // and tag the body with the active format so CSS can branch (zoom
    // transform, etc.) — even when the pane is hidden we set it so a
    // subsequent re-open picks up the right scale immediately.
    previewPane.body.dataset.format = format;
    previewPane.body.style.setProperty("--typst-zoom", String(getTypstZoom()));
  }

  // Per-format extensions (Typst language highlight + diagnostics field)
  // live behind a Compartment so we can swap them in/out as the user opens
  // files of different formats. Initially empty until the first
  // applyFormatExtensions() call below.
  const formatCompartment = new Compartment();
  view.dispatch({
    effects: StateEffect.appendConfig.of(formatCompartment.of([])),
  });

  function applyFormatExtensions(): void {
    const format = detectFormat(currentPath);
    const exts =
      format === "typst"
        ? [typstFormat.languageExtension, typstDiagnosticsExtension()]
        : [];
    view.dispatch({ effects: formatCompartment.reconfigure(exts) });
  }

  // Typst compile driver — one session per open .typ file. Compiles fire on
  // a debounce; we keep a sequence counter to discard results from stale
  // compiles that lose the race to a newer source revision.
  let typstDriver: TypstDriver | null = null;
  let typstCompileTimer: ReturnType<typeof setTimeout> | null = null;
  let typstCompileSeq = 0;
  const TYPST_COMPILE_DEBOUNCE_MS = 300;

  async function openTypstSessionIfNeeded(): Promise<void> {
    if (detectFormat(currentPath) !== "typst") {
      // Switched away from typst — tear down any prior session.
      if (typstDriver) {
        await typstDriver.close();
        typstDriver = null;
      }
      toolbar.setStatus(null);
      return;
    }
    if (!currentPath) return;
    if (typstDriver) await typstDriver.close();
    typstDriver = createTypstDriver();
    try {
      await typstDriver.open(currentPath);
    } catch (err) {
      console.warn("typst_open failed", err);
      typstDriver = null;
      return;
    }
    scheduleTypstCompile(); // kick off the first compile immediately
  }

  function scheduleTypstCompile(): void {
    if (!typstDriver) return;
    if (typstCompileTimer) clearTimeout(typstCompileTimer);
    typstCompileTimer = setTimeout(() => {
      typstCompileTimer = null;
      void runTypstCompile();
    }, TYPST_COMPILE_DEBOUNCE_MS);
  }

  async function runTypstCompile(): Promise<void> {
    if (!typstDriver) return;
    const mySeq = ++typstCompileSeq;
    toolbar.setStatus(t("typst.compiling"));
    let result: CompileResult;
    try {
      result = await typstDriver.compile(view.state.doc.toString());
    } catch (err) {
      console.warn("typst compile failed", err);
      toolbar.setStatus(null);
      return;
    }
    // Discard if a newer compile started after we kicked off. The newer
    // compile's own resolution will overwrite the pane.
    if (mySeq !== typstCompileSeq) return;

    if (result.pages.length > 0) {
      previewPane.setPages(result.pages);
      previewPane.body.classList.remove("typst-pane-stale");
    } else if (result.diagnostics.some((d) => d.severity === "error")) {
      // Failed compile with prior content — dim it instead of clearing.
      previewPane.body.classList.add("typst-pane-stale");
    }
    const errorCount = result.diagnostics.filter(
      (d) => d.severity === "error",
    ).length;
    if (errorCount === 1) {
      toolbar.setStatus(t("typst.one_error"));
    } else if (errorCount > 1) {
      toolbar.setStatus(tA11y("typst.n_errors", { n: String(errorCount) }));
    } else {
      toolbar.setStatus(
        tA11y("typst.compiled_in", { ms: String(result.elapsed_ms) }),
      );
    }
    view.dispatch({ effects: setTypstDiagnostics.of(result.diagnostics) });
  }

  setDocumentFormatAttr();
  applyPreviewPaneLayout();

  window.addEventListener("beforeunload", () => {
    if (typstDriver) void typstDriver.close();
  });

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
  // Skip recents for a brand-new (`md newfile.md`) buffer until first save —
  // otherwise the recents list points at a path that doesn't exist on disk.
  if (currentPath && !initialDoc?.isNew) await recordRecent(currentPath);

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
   * sidebar, ensure the sidebar is visible. Pass null to clear.
   *
   * When `opts.replaceBuffer` is true (the project-switch path — user picked
   * a different project from the palette / menu), the active editor buffer
   * is replaced via the per-project fallback chain (last-in-project → root
   * README.md → welcome). The file from the *previous* project is irrelevant
   * to the new one — keeping it open conflates window state with project
   * state, which is the root cause of #122. The default (`false`) is the
   * cold-start / file-derived path: caller already loaded a doc into the
   * buffer (or has none and wants the welcome placeholder) and just wants
   * the sidebar to reflect the project. */
  async function setCurrentFolder(
    root: string | null,
    opts: { replaceBuffer?: boolean } = {},
  ): Promise<void> {
    // Canonicalize before any identity check or persistence so the same folder
    // reached via different spellings (a symlink, a `..`-relative path, the
    // bare basename from the CLI shim) collapses to one identity across the
    // recents list, sidebar root, file-position cache, window-routing map, and
    // pairing's synced-folders set. See issue #99.
    if (root) root = await canonicalizePath(root);
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
    if (opts.replaceBuffer) {
      await applyProjectFallbackBuffer(root);
    }
    // Reflect the (possibly changed) project name in the window title. The
    // file may not have changed — only the folder root — so refresh here
    // rather than relying on the path-driven title updates. Skipped on the
    // replaceBuffer path since loadAndApplyDoc already set the title with the
    // new currentFolder.
    if (!opts.replaceBuffer) {
      await setWindowTitle(currentPath, dirtyTracker.isDirty(), currentFolder);
      // Also refresh the *visible* custom titlebar / toolbar name — on macOS
      // the OS title set above is hidden, so this is the only place the project
      // name actually appears (issue #98).
      toolbar.setPath(currentPath, currentFolder);
    }
  }

  /** Raise a window to the foreground: unminimize if needed, then focus.
   * Implements issue #100's "always raise + focus" for a window that may be
   * minimized, hidden, or on another Space. */
  async function raiseWindow(label: string): Promise<void> {
    const w = await WebviewWindow.getByLabel(label);
    if (!w) return;
    try {
      if (await w.isMinimized()) await w.unminimize();
    } catch {
      // isMinimized/unminimize unsupported or window vanished — focus anyway.
    }
    await w.setFocus();
  }

  /** Route a "switch to folder" request (issue #100). The main window owns
   * folderByLabel and is the sole decision-maker, mirroring file-open-request.
   *   - target already shown by a live window → raise + focus it;
   *   - requesting window is unclaimed        → adopt the folder in place;
   *   - otherwise                              → spawn a new window for it. */
  async function routeToFolder(
    target: string,
    requestingLabel: string,
  ): Promise<void> {
    target = await canonicalizePath(target);

    // Prune stale labels (a closed window can lag the map by a frame) so a
    // focus decision never targets a dead window. Same guard the
    // file-open-request handler uses.
    for (const [label, folder] of [...folderByLabel]) {
      if (folder !== target) continue;
      if (!(await WebviewWindow.getByLabel(label))) folderByLabel.delete(label);
    }

    const route = decideProjectRoute({
      target,
      requestingLabel,
      requestingFolder: folderByLabel.get(requestingLabel) ?? null,
      folderByLabel,
    });

    if (route.kind === "focus") {
      // Always raise the owning window — including when it *is* the
      // requesting window. For in-app project switches the requester is
      // already frontmost so this is a harmless no-op, but for a
      // `file-open-request` from `md .` the requester is always the main
      // window, which may not be frontmost (another app or a secondary
      // window was). Raising it here is what brings folder A's window
      // forward; the Rust side deliberately no longer calls set_focus()
      // so this routing decision is the sole source of focus (issue #137).
      await raiseWindow(route.label);
      return;
    }
    if (route.kind === "adopt") {
      await emitTo(requestingLabel, "viewer:adopt-folder", target);
      return;
    }
    await spawnNewWindow({ folder: target });
  }

  /** Replace the active buffer with the project-fallback file (or the
   * welcome placeholder when the chain yields null). Called on user-driven
   * project switches; not on cold-start (the bootstrap already chose an
   * initial doc) and not on file-derived `syncFolderToFile` (the doc just
   * loaded is what we want). */
  async function applyProjectFallbackBuffer(root: string | null): Promise<void> {
    if (!root) {
      // Closing the project — leave the current buffer alone. The user can
      // continue editing whatever file they had open; only the sidebar
      // disappears.
      return;
    }
    let next: string | null = null;
    try {
      next = await resolveProjectFallbackFile(root);
    } catch {
      next = null;
    }
    if (next) {
      try {
        await loadAndApplyDoc(next);
        return;
      } catch {
        // File listed by the walker but unreadable (permissions / race) —
        // forget the per-project pointer so we don't loop on it next time,
        // and fall through to the welcome buffer.
        await forgetFileInProject(root);
      }
    }
    // Welcome buffer: no path, no dirty state.
    if (currentPath) {
      try {
        const prevKey = await canonicalizePath(currentPath);
        await setFilePosition(prevKey, captureCurrentPosition());
      } catch {
        // best-effort
      }
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: defaultPlaceholder() },
    });
    currentPath = null;
    dirtyTracker.reset();
    diverged = false;
    await setWindowTitle(null, false);
    toolbar.setPath(null);
    toc.setDocumentTitle(null);
    folder.setActiveFile(null);
    setDocumentFormatAttr();
    applyPreviewPaneLayout();
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

  const unsubAdoptFolder = await listen<string>("viewer:adopt-folder", (e) => {
    void setCurrentFolder(e.payload, { replaceBuffer: true });
  });
  window.addEventListener("beforeunload", () => unsubAdoptFolder());

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

  // Initial folder: prefer an explicit launch-time directory (e.g. `md <dir>`
  // or Finder "Open With…" on a folder), then derive from the opened file if
  // there is one; otherwise restore from the per-window session entry
  // (preferred) or the legacy global `currentFolder` key (fallback for first-
  // launch / new windows). The launch-time folder wins because the user just
  // asked for it; we don't want a stale session folder to override it.
  if (initialFolder) {
    void (async () => {
      try {
        await setCurrentFolder(initialFolder);
      } catch {
        // Folder unreadable / disappeared between arg-parse and listing —
        // leave the panel hidden; the file-open-request listener handles
        // user-facing errors elsewhere.
      }
    })();
  } else if (currentPath) {
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
  // Crash recovery: the buffer already holds the recovered dump (set as the
  // initial doc by resolveInitial). Seed the dirty tracker against the
  // on-disk content so the dirty dot lights up immediately and Cmd-S writes
  // the recovered edits back to the file.
  if (recoveredDoc) {
    dirtyTracker.markDirtyAgainst(recoveredDoc.diskBaseline);
  }
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
    toolbar.setPath(currentPath, currentFolder);
    await setWindowTitle(currentPath, dirty, currentFolder);
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
          if (detectFormat(currentPath) === "typst") scheduleTypstCompile();
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
      // First save of a `md newfile.md` buffer: the watcher couldn't engage
      // earlier because the path didn't exist on disk. It does now —
      // start watching and add it to recents.
      if (!watcherHandle) {
        await recordRecent(currentPath);
        await startWatching(currentPath);
      }
    } catch (err) {
      console.error("save failed", err);
    }
  };
  setSaveHandler(() => { void triggerSave(); });

  // Force-save: writes the buffer to disk unconditionally — overwrites the
  // file even when the buffer is `diverged`. Used by window-close and app-
  // quit, where there's no user to answer a "save anyway?" prompt and silent
  // data loss is the worst outcome. Skips when there's no path (a brand-new
  // unsaved buffer would need a Save As… dialog, which we can't show during
  // close); the periodic recovery dump still covers that case.
  const forceSave = async (): Promise<void> => {
    if (!currentPath) return;
    if (watcherHandle) await watcherHandle.markSelfWrite();
    await saveDoc(currentPath, view.state.doc.toString());
    dirtyTracker.reset();
    diverged = false;
    try {
      await clearRecovery(currentPath);
    } catch {
      // best-effort; recovery dump is a fallback, not the primary path
    }
  };
  const stopCloseHandler = await installCloseHandler({
    isDirty: () => dirtyTracker.isDirty(),
    forceSave,
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
    await setWindowTitle(currentPath, false, currentFolder);
    toolbar.setPath(currentPath, currentFolder);
    toc.setDocumentTitle(currentPath);
    folder.setActiveFile(currentPath);
    if (currentPath) {
      if (doc.isNew) {
        // Brand-new file: drop straight into edit mode so the user can start
        // typing. For .typ files the default mode is reading (pane is the
        // primary surface) — except a brand-new empty .typ, which would be
        // a blank pane with no source visible, so we still force edit.
        if (currentMode !== "edit") {
          currentMode = "edit";
          setMode(view, "edit", modeExtensions.edit);
          toolbar.setMode("edit");
          document.documentElement.dataset.mode = "edit";
        }
      }
      if (!doc.isNew) {
        await recordRecent(currentPath);
        await startWatching(currentPath);
      }
      await maybeRestorePositionFor(currentPath);
      await syncFolderToFile(currentPath);
      // Pair this file with the active project so a future switch back to
      // the project (or restore on relaunch) re-opens this file rather than
      // the newest-overall recent. syncFolderToFile may have just set
      // currentFolder, so consult it *after*.
      if (currentFolder && !doc.isNew) {
        await recordFileInProject(currentFolder, currentPath);
      }
    }
    applyFormatExtensions();
    setDocumentFormatAttr();
    applyPreviewPaneLayout();
    if (detectFormat(currentPath) === "typst") {
      await openTypstSessionIfNeeded();
    }
  }

  /** Mirror the active document's format onto <html>'s dataset so CSS can
   * branch reading-mode behavior per format (e.g. `.typ` reading mode hides
   * the editor and gives the preview pane the full width). */
  function setDocumentFormatAttr(): void {
    document.documentElement.dataset.format = detectFormat(currentPath);
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

  // Reading-mode link clicks. The extension itself gates on
  // view.state.readOnly so edit-mode cursor placement stays untouched.
  // Local-markdown resolution needs `currentPath` to anchor relative refs;
  // we read it through closures so subsequent file opens stay in sync.
  const linkHandlers: LinkClickHandlers = {
    openExternal: async (url) => {
      try {
        await openExternalUrl(url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Surface failures non-modally — a broken URL shouldn't trap the user.
        console.warn("openUrl failed", msg);
      }
    },
    openLocalMarkdown: async (absPath) => {
      try {
        await openWithDirtyPrompt(absPath);
      } catch (err) {
        console.warn("openLocalMarkdown failed", err);
      }
    },
    resolveRelativeMarkdown: async (rawPath) => {
      if (!currentPath) return null;
      // Strip query/fragment so dirname-relative resolution sees just the
      // file path. `?` and `#` are not valid in POSIX filenames anyway.
      const cleaned = rawPath.replace(/[?#].*$/, "");
      try {
        const { dirname, resolve, isAbsolute } = await import(
          "@tauri-apps/api/path"
        );
        if (await isAbsolute(cleaned)) return cleaned;
        const baseDir = await dirname(currentPath);
        return await resolve(baseDir, cleaned);
      } catch {
        return null;
      }
    },
    scrollToAnchor: (slug) => {
      const decoded = (() => {
        try {
          return decodeURIComponent(slug);
        } catch {
          return slug;
        }
      })();
      const index = buildAnchorIndex(view.state.doc.toString());
      const offset = index.get(decoded);
      if (offset == null) return false;
      view.dispatch({
        effects: EditorView.scrollIntoView(offset, { y: "start" }),
      });
      return true;
    },
  };
  view.dispatch({
    effects: StateEffect.appendConfig.of(linkClickExtension(linkHandlers)),
  });

  // Per-window menu handlers. The Tauri app menu fires its callbacks in
  // whichever webview last set it (typically main), so without routing each
  // action would run against that window's state regardless of focus. We
  // install these as a listener in every window and have the menu dispatch
  // the action to the focused window via emitTo. Theme is broadcast to all
  // windows so light/dark stays in sync.
  const buildCurrentHtml = () =>
    buildHtmlExport(view.state.doc.toString(), {
      title: documentTitleFromPath(currentPath),
    });
  const localHandlers: LocalMenuHandlers = {
    openFile: async () => {
      const doc = await openFileViaDialog();
      if (doc) await loadAndApplyDoc(doc.path);
    },
    openFolder: async () => {
      const root = await pickFolder();
      // Route through the same focus/adopt/spawn logic as Switch Project so
      // Open Folder also honors the 1:1 folder↔window mapping (#100).
      if (root) void emit("viewer:switch-project-request", { folder: root, fromLabel: selfLabel });
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
      await setWindowTitle(currentPath, false, currentFolder);
      toolbar.setPath(currentPath, currentFolder);
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
    toggleSidebar,
    setTheme: (t) => setActiveTheme(t),
    zoomIn: () => zoomByFn(view, +1),
    zoomOut: () => zoomByFn(view, -1),
    zoomReset: () => zoomResetFn(view),
    openFind: () => { openSearchPanel(view); },
    openReplace: () => { openSearchPanel(view); },
    openRecent: async (path) => { await loadAndApplyDoc(path); },
    clearRecents: async () => { await clearRecents(); },
    exportHtml: async () => {
      const html = await buildCurrentHtml();
      const defaultName = exportFileNameFromPath(currentPath, "html");
      await saveHtmlExport(html, defaultName);
    },
    printDocument: () => {
      void (async () => {
        const html = await buildCurrentHtml();
        openPrintWindow(html);
      })();
    },
    copyAsHtml: async () => {
      const html = await buildCurrentHtml();
      await writeClipboardHtml(html);
    },
    openPreferences: async () => {
      await openPreferences();
    },
    showKeyboardShortcuts: () => { void openKeyboardShortcuts(); },
    openProject: async (path) => {
      // Don't switch in place — let the main window route to the right window
      // (focus existing / adopt here / spawn new). See issue #100.
      void emit("viewer:switch-project-request", { folder: path, fromLabel: selfLabel });
    },
    clearRecentProjects: async () => { await clearRecentProjects(); },
    openProjectPalette: () => { void openProjectPalette(); },
    quickOpen: () => { void openQuickOpenPalette(currentFolder); },
    newTypstFile: async () => {
      const dest = await saveTypstAs("= Document title\n\n", "untitled.typ");
      if (!dest) return;
      await loadAndApplyDoc(dest);
    },
  };
  const unsubMenuActions = await installMenuActionListener(localHandlers);
  window.addEventListener("beforeunload", () => unsubMenuActions());

  // Custom right-click menu on the editor (issue #103). Suppresses the
  // native WKWebView/WebView2 context menu inside the editor and renders
  // a short mode-aware menu of commands the app already implements.
  // Other surfaces (sidebar, modals) keep their native menu.
  const contextMenuHandle = mountContextMenu({
    view,
    handlers: {
      copyAsHtml: () => localHandlers.copyAsHtml(),
      openFind: () => localHandlers.openFind(),
      revealInFileManager: () => localHandlers.revealInFileManager(),
      toggleMode: () => localHandlers.toggleMode(),
    },
    getCurrentPath: () => currentPath,
    getMode: () => currentMode,
  });
  window.addEventListener("beforeunload", () => contextMenuHandle.destroy());

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

  // Window-level Cmd-Shift-L = toggle sidebar. Capture phase so it fires
  // regardless of focus; plain-input guard so it doesn't hijack the
  // sidebar's filter while the user is typing in it.
  const onSidebarKey = (e: KeyboardEvent): void => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.altKey || !e.shiftKey) return;
    if (e.key.toLowerCase() !== "l") return;
    const target = e.target as HTMLElement | null;
    if (target && isPlainEditableInput(target)) return;
    e.preventDefault();
    e.stopPropagation();
    toggleSidebar();
  };
  window.addEventListener("keydown", onSidebarKey, true);
  window.addEventListener("beforeunload", () => {
    window.removeEventListener("keydown", onSidebarKey, true);
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
      newTypstFile: () => dispatchToFocused({ type: "newTypstFile" }),
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

  // Skip the fs watcher for a new (not-yet-created) file. notify can't watch
  // a path that doesn't exist; it'll start on first save via loadAndApplyDoc.
  if (currentPath && !initialDoc?.isNew) {
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
      await setCurrentFolder(paths[0], { replaceBuffer: true });
      return;
    }

    const docFiles = paths.filter((p) => isSupportedExtension(p));
    if (docFiles.length === 0) return;

    // First doc goes to the current window. Any additional ones spawn new
    // windows pre-loaded with their respective files — so dragging five
    // doc files yields five windows, each on its own document.
    await openWithDirtyPrompt(docFiles[0]);
    for (let i = 1; i < docFiles.length; i++) {
      await spawnNewWindow({ file: docFiles[i] });
    }
  });
  window.addEventListener("beforeunload", () => unsubDrop());

  await setWindowTitle(initialDoc?.path ?? null, false, currentFolder);

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
      // Same routing as in-app Switch Project: focus existing window, adopt
      // into the (blank) main window, or spawn. See issue #100.
      await routeToFolder(paths[0], selfLabel);
      return;
    }
    const doc = paths.find((p) => isSupportedExtension(p));
    if (!doc) return;
    let targetRoot: string | null = null;
    try { targetRoot = await resolveFolderRoot(doc); } catch { /* fall through */ }
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
      await emitTo(matchedLabel, "viewer:open-file", doc);
      // Raise the owning window — including when it is the main window
      // itself. The Rust side no longer set_focus()es the frontmost
      // window (issue #137), so without raising here a `md <file>` for a
      // file in main's folder would foreground the app but leave main
      // unraised if another window/app was frontmost. raiseWindow on the
      // already-frontmost window is a harmless no-op.
      await raiseWindow(matchedLabel);
    } else {
      await spawnNewWindow({ file: doc });
    }
  });
  window.addEventListener("beforeunload", () => unsubFileOpen());

  const unsubSwitchProject = await listen<{ folder: string; fromLabel: string }>(
    "viewer:switch-project-request",
    async (e) => {
      if (!isMainWindow()) return;
      await routeToFolder(e.payload.folder, e.payload.fromLabel);
    },
  );
  window.addEventListener("beforeunload", () => unsubSwitchProject());

  // (The highlight / mermaid / graphviz cache subscriptions were moved up to
  // immediately after createEditor — see the note there — so the first
  // bootstrap-time cache fill isn't lost before a subscriber exists.)

  // Install per-format extensions for the initial doc (no-op for .md). If the
  // initial doc is a .typ file, also open the compile session. Reading mode
  // for .typ now renders the pane full-width with the editor hidden, so we
  // do NOT force edit mode here — the restored mode (or default `reading`)
  // wins, mirroring how Markdown initial docs are handled.
  applyFormatExtensions();
  if (currentPath && detectFormat(currentPath) === "typst") {
    await openTypstSessionIfNeeded();
    applyPreviewPaneLayout();
  }
}

interface InitialResolution {
  doc: OpenedDoc | null;
  /** Folder to open as sidebar root, e.g. when the user ran `md <dir>` or
   * dropped a folder onto the app icon. Independent from `doc` — the user may
   * launch with just a folder and no file. */
  folder: string | null;
}

async function resolveInitial(
  sessionFallbackPath: string | null = null,
  sessionFallbackFolder: string | null = null,
): Promise<InitialResolution> {
  // Secondary windows opened with ?file=… (drop-onto-window splits a multi-
  // file drop across windows, and multi-window session restore reuses the
  // same channel) load that file directly.
  const urlFile = fileFromUrlQuery();
  if (urlFile) {
    try {
      return { doc: await readDoc(urlFile), folder: null };
    } catch {
      // Fall through if the path can't be read; window stays blank.
    }
  }

  // A window spawned for a project (issue #100) carries its folder root as a
  // query param. Run the per-project fallback chain (last-in-project → root
  // README → welcome) so the new window opens the project's active file with
  // the sidebar rooted at that folder — mirroring the session-restore branch
  // below.
  const urlFolder = folderFromUrlQuery();
  if (urlFolder) {
    const fallbackFile = await resolveProjectFallbackFile(urlFolder);
    if (fallbackFile) {
      try {
        return { doc: await readDoc(fallbackFile), folder: urlFolder };
      } catch {
        // Listed but unreadable — fall through to the placeholder in-project.
      }
    }
    return { doc: null, folder: urlFolder };
  }

  // Other secondary windows (plain File -> New Window) start blank — the user
  // opens a file explicitly. Avoids two windows fighting over the same restore
  // flow and avoids surprising side effects (re-opening last file in a brand-
  // new window).
  if (!isMainWindow()) return { doc: null, folder: null };

  if (recoveredDoc) return { doc: recoveredDoc, folder: null };
  const argPath = await firstMarkdownArg();
  if (argPath) return { doc: await readDoc(argPath), folder: null };
  // The Rust side buffers paths that the OS handed to us via
  // RunEvent::Opened before the frontend was ready to receive events
  // (and also paths from URLs that tao's broken application:openURLs:
  // would have panicked on — see src-tauri/src/mac_tao_patch.rs).
  // Pull them in before falling back to the listener-based wait.
  const buffered = await takePendingOpenPaths();
  const bufferedKind = await classifyOpenPaths(buffered);
  if (bufferedKind?.kind === "file") {
    return { doc: await readDoc(bufferedKind.path), folder: null };
  }
  if (bufferedKind?.kind === "directory") {
    return { doc: null, folder: bufferedKind.path };
  }
  // macOS file-association launches deliver the path via RunEvent::Opened,
  // which can fire after bootstrap starts. Wait briefly for it before
  // falling back to last-opened or the open dialog — otherwise double-
  // clicking a .md in Finder briefly shows a redundant open dialog before
  // the doc loads. The payload can be a markdown file (open it) or a
  // directory (open as sidebar root, see issue #48).
  const launched = await waitForOpenRequest(500);
  if (launched?.kind === "file") {
    return { doc: await readDoc(launched.path), folder: null };
  }
  if (launched?.kind === "directory") {
    return { doc: null, folder: launched.path };
  }
  // Window-session restore for the main window: the active *project* (folder)
  // outranks the active *file*. If the session captured a folder, run the
  // per-project fallback chain (last-in-project → root README → welcome)
  // against it and return that. This is what #122 fixes: the file recorded
  // alongside the folder may not even belong to it (the user could have
  // switched projects after opening that file), so trusting the recorded
  // file blindly is the bug. The chain resolves to the file the *project*
  // says was active, not the file the *app* last touched globally.
  //
  // If the folder is missing on disk we drop it silently (per #122 ACs) and
  // fall through to the recorded file / generic recents. No prompt.
  if (sessionFallbackFolder) {
    const folderExists = await pathExists(sessionFallbackFolder);
    if (folderExists) {
      const fallbackFile = await resolveProjectFallbackFile(
        sessionFallbackFolder,
      );
      if (fallbackFile) {
        try {
          return {
            doc: await readDoc(fallbackFile),
            folder: sessionFallbackFolder,
          };
        } catch {
          // Listed but unreadable — fall through to welcome buffer in this
          // project rather than abandoning the project context entirely.
        }
      }
      // No fallback file — show the welcome buffer *inside* the restored
      // project (sidebar reflects the folder, editor is the placeholder).
      return { doc: null, folder: sessionFallbackFolder };
    }
    // Folder gone — drop silently and continue with the other branches.
  }
  // Pre-#122 session entries (or session entries with no folder) still get
  // the recorded file as a fallback path, mirroring the original behaviour.
  if (sessionFallbackPath) {
    try {
      return { doc: await readDoc(sessionFallbackPath), folder: null };
    } catch {
      // file missing/moved — fall through to recents/dialog
    }
  }
  // Re-open whatever was open last time the app closed (recents[0] is the
  // most-recently-opened path, written on every successful open via
  // recordRecent). Falls through to the dialog if the file is gone.
  const lastOpened = await tryReopenLastFile();
  if (lastOpened) return { doc: lastOpened, folder: null };
  return { doc: await openFileViaDialog(), folder: null };
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
  for (const entry of dedupeSessionByFolder(session.windows)) {
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

/** Wait briefly for the OS to deliver an `Open With…` / `md <path>` request,
 *  classifying the payload as either a markdown file or a directory. Resolves
 *  to null on timeout. The same event is consumed by the post-bootstrap
 *  listener that handles subsequent opens (drag-onto-dock while running),
 *  but THAT listener is registered too late to receive the cold-launch event
 *  on macOS — RunEvent::Opened fires once during builder.run and isn't
 *  queued. Hence the early listener here. */
async function waitForOpenRequest(
  timeoutMs: number,
): Promise<{ kind: "file" | "directory"; path: string } | null> {
  return new Promise((resolve) => {
    let unlisten: (() => void) | null = null;
    const timer = setTimeout(() => {
      unlisten?.();
      resolve(null);
    }, timeoutMs);
    void listen<string[]>("file-open-request", async (e) => {
      const paths = Array.isArray(e.payload) ? e.payload : [];
      if (paths.length === 0) return;
      // Prefer a markdown file when one is present; otherwise check whether
      // the single argument is a directory. (We don't currently support
      // launching with multiple folder args — `md a/ b/` would only open
      // the first.)
      const md = paths.find((p) => isSupportedExtension(p));
      if (md) {
        clearTimeout(timer);
        unlisten?.();
        resolve({ kind: "file", path: md });
        return;
      }
      if (paths.length === 1) {
        try {
          if (await isDirectory(paths[0])) {
            clearTimeout(timer);
            unlisten?.();
            resolve({ kind: "directory", path: paths[0] });
            return;
          }
        } catch {
          // ignore — fall through to timeout
        }
      }
    }).then((u) => {
      unlisten = u;
    });
  });
}

async function takePendingOpenPaths(): Promise<string[]> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("take_pending_open_paths");
  } catch {
    return [];
  }
}

async function classifyOpenPaths(
  paths: string[],
): Promise<{ kind: "file" | "directory"; path: string } | null> {
  if (paths.length === 0) return null;
  const md = paths.find((p) => isSupportedExtension(p));
  if (md) return { kind: "file", path: md };
  if (paths.length === 1) {
    try {
      if (await isDirectory(paths[0])) {
        return { kind: "directory", path: paths[0] };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function firstMarkdownArg(): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const argv = await invoke<string[]>("plugin:cli|argv").catch(() => null);
    if (!argv) return null;
    return argv.find((a) => isSupportedExtension(a)) ?? null;
  } catch {
    return null;
  }
}

function documentTitleFromPath(path: string | null): string {
  if (!path) return "Document export";
  const base = path.split(/[\\/]/).pop() ?? path;
  // Strip any supported document extension so the export filename and
  // print-window title read as the bare document name.
  return base.replace(/\.(md|markdown|mdx|mdown|typ)$/i, "");
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

/** Open a new app window. Without options the new window starts as a blank
 * slate — the user opens a file via dialog or drag-drop. Pass `file` to
 * pre-load a document (`?file=…`), or `folder` to open with a sidebar root
 * pre-set (`?folder=…`). */
async function spawnNewWindow(
  opts: { file?: string; folder?: string } = {},
): Promise<void> {
  const label = await nextWindowLabel();
  let url = "/";
  if (opts.folder) {
    url = `/?folder=${encodeURIComponent(opts.folder)}`;
  } else if (opts.file) {
    url = `/?file=${encodeURIComponent(opts.file)}`;
  }
  const win = new WebviewWindow(label, {
    title: "Viewer",
    width: 1000,
    height: 760,
    minWidth: 480,
    minHeight: 320,
    dragDropEnabled: true,
    // macOS: hide native chrome so the custom titlebar can host the toggles
    // and stats. Windows/Linux silently ignore these fields.
    titleBarStyle: "overlay",
    hiddenTitle: true,
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
    // Match the declarative window config so restored windows also get the
    // custom titlebar treatment on macOS. Non-mac platforms ignore these.
    titleBarStyle: "overlay",
    hiddenTitle: true,
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

function folderFromUrlQuery(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const f = params.get("folder");
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

import { isMobile } from "./platform";

if (isMobile()) {
  // v2 mobile companion, step 1: render a bundled sample.md only. The
  // mobile path is loaded lazily so the desktop bundle doesn't get the
  // mobile-bootstrap module's eager imports on cold start.
  import("./mobile-bootstrap")
    .then((m) => m.mobileBootstrap())
    .catch((err) => {
      console.error("mobile bootstrap failed", err);
      const root = document.getElementById("root");
      if (root) root.textContent = `Failed to start: ${String(err)}`;
    });
} else {
  bootstrap().catch((err) => {
    console.error("bootstrap failed", err);
    const root = document.getElementById("root");
    if (root) {
      root.textContent = `Failed to start: ${String(err)}`;
    }
  });
}
