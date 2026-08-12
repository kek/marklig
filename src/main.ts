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
import { readingLinkWidgetsProducer } from "./editor/decorations/reading-links";
import { mathProducer } from "./editor/decorations/math";
import { mermaidProducer, mermaidCache, mermaidCacheEffect } from "./editor/decorations/mermaid";
import { graphvizProducer, graphvizCache, graphvizCacheEffect } from "./editor/decorations/graphviz";
import { localImageCache, localImageCacheEffect } from "./editor/decorations/local-images";
import { lineNamesProducer } from "./editor/decorations/line-names";
import { loadSettings, subscribeSettings, getAutoSave, getPreviewPaneWidth, setPreviewPaneWidth, getTypstZoom, adjustTypstZoom, resetTypstZoom } from "./shell/settings";
import {
  claimMenu,
  installSessionReporting,
  requestOpen,
  newWindow as requestNewWindow,
  type WindowMode,
} from "./shell/session-client";
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
import { readDoc, openFileViaDialog, saveDoc, saveHtmlExport, savePdfExport, saveDocumentAs, saveTypstAs, revealInFileManager as fsReveal, pickFolder, isDirectory, resolveFolderRoot, type OpenedDoc } from "./shell/files";
import { message } from "@tauri-apps/plugin-dialog";
import { buildHtmlExport } from "./export/html";
import { buildTypstHtmlExport } from "./export/typst-html";
import { decideExportRoute, saveAsExtension, type TypstRenderState } from "./export/route";
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
import { getFilePosition, setFilePosition, canonicalizePath, planPositionRestore } from "./shell/file-positions";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
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
  // Size and position are set by Rust when it creates the window (see
  // `session::spawn_window`), so there is nothing to restore here — and no
  // default-sized flash to hide.

  await primeHighlighter([
    "javascript", "typescript", "python", "go", "rust",
    "java", "c", "cpp", "shell", "json", "yaml", "sql",
    "html", "css", "markdown",
  ]);

  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  root.innerHTML = "";

  async function maybeRestoreFromRecovery(): Promise<void> {
    // Which dump belongs to this window was decided in
    // `src-tauri/src/session/launch.rs`, which pairs each dump with the
    // window that owns its file and gives an unclaimed dump a window of its
    // own. We load exactly the one we were handed — no window scans the
    // whole recovery store any more, which is what used to make a secondary
    // window's dump land in `main` or vanish.
    //
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
    const wanted = dumpFromUrlQuery();
    if (!wanted) return;
    const entries = (await readAllRecovery()).filter((e) => e.originalPath === wanted);
    if (entries.length === 0) return;
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

  // Every window — main or secondary — may own a dump; Rust decided which
  // one when it planned this window's launch and handed it over as `?dump=`.
  await maybeRestoreFromRecovery();

  // Every window's initial state arrives as URL parameters that Rust set when
  // it created the window. Session restore, launch arguments and project
  // fallback ordering were all resolved in `src-tauri/src/session/launch.rs`
  // before this window existed.
  const { doc: initialDoc, folder: initialFolder } = await resolveInitial();

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

  // Local images are read off disk asynchronously (relative/absolute paths
  // can't be assigned to <img src> from the tauri://localhost origin). Re-run
  // decorations when a read lands, and let the cache resolve relative paths
  // against — and revoke object URLs on a change of — the open document.
  localImageCache.setDocPathGetter(() => currentPath);
  const unsubscribeLocalImage = localImageCache.subscribe(() => {
    view.dispatch({ effects: localImageCacheEffect.of() });
  });
  window.addEventListener("beforeunload", () => unsubscribeLocalImage());

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
  const readingProducers = [...editingProducers, readingWidgetsProducer, readingLinkWidgetsProducer, mathProducer, mermaidProducer, graphvizProducer];

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

  // Read the ?mode= / ?scrollTop= / ?sidebar= parameters Rust set on this
  // window's URL up front — the sidebar's initial visibility (below) needs
  // the sidebar param before the TOC mounts; mode/scrollTop are consumed
  // further down once modeExtensions exists.
  const urlRestore = restoreParamsFromUrl();

  const initialHeadings = countHeadings(view.state.doc.toString());
  const initialTocPath = initialDoc?.path ?? "";
  const toc: TocSidebarHandle = mountTocSidebar({
    view,
    parent: shell,
    // Absent ?sidebar= (no recorded preference) falls back to the existing
    // heading-count heuristic; an explicit true/false from a restored
    // session always wins, including a deliberately-hidden sidebar.
    initiallyVisible:
      urlRestore.sidebarVisible ?? shouldShowSidebar(initialTocPath, initialHeadings),
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
  function restorePosition(
    target: { scrollTop: number; line: number; col: number },
    opts: { restoreCursor: boolean } = { restoreCursor: true },
  ): void {
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
    // remembered line past EOF doesn't blow up. Skipped for link-initiated
    // opens (restoreCursor=false), which must land at the top with NO visible
    // cursor/selection so following an internal link doesn't highlight a
    // section (issue #161).
    if (opts.restoreCursor) {
      try {
        const docLines = view.state.doc.lines;
        const targetLine = Math.max(1, Math.min(target.line || 1, docLines));
        const lineObj = view.state.doc.line(targetLine);
        const offset = Math.min(lineObj.from + Math.max(0, target.col), lineObj.to);
        view.dispatch({ selection: { anchor: offset, head: offset } });
      } catch {
        // Out-of-range or empty doc — skip cursor restore, scroll-only is fine.
      }
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
   * asked us to honor).
   *
   * `fromLink` marks an open initiated by clicking an internal Markdown link:
   * those always reset to the top with no restored cursor (issue #161). All
   * other open paths (recents, session restore, reopen-last, folder-tree)
   * restore the saved position. */
  async function maybeRestorePositionFor(
    path: string | null,
    opts: { fromLink: boolean } = { fromLink: false },
  ): Promise<void> {
    if (!path) return;
    if (window.location.hash && window.location.hash.length > 1) return;
    try {
      const key = await canonicalizePath(path);
      const saved = await getFilePosition(key);
      // A file with a saved position restores to it; one without (never
      // scrolled, or first open) — and every link-initiated open — must reset
      // to the top. Without the explicit reset, the previous doc's scrollTop
      // bleeds through (issue #146). Routing the reset through restorePosition
      // (rather than a bare `scrollTop = 0`) reuses the rAF watchdog so it
      // survives late Shiki/Mermaid reflow, and arms suppressPositionSave so we
      // don't immediately persist scrollTop=0 over a real saved position the
      // user may want when they reach this file through a non-link path later
      // (issue #161).
      const plan = planPositionRestore(saved, opts);
      restorePosition(plan.target, { restoreCursor: plan.restoreCursor });
    } catch {
      // best-effort
    }
  }

  const modeExtensions = {
    reading: { decorations: readingSet, keymap: readingKeymap },
    edit:    { decorations: editingSet, keymap: editKeymap },
  };

  // Restore mode + scroll position from the ?mode= / ?scrollTop= parameters
  // Rust set on this window's URL (parsed into `urlRestore` above, before the
  // TOC mounted). Every window — main included — is created by Rust, so this
  // is the only channel; if either param is absent the defaults (reading
  // mode, scrollTop 0) win.
  // A cold launch via `md newfile.md` lands here with initialDoc.isNew true.
  // Force edit mode so the user can start typing immediately; otherwise the
  // window opens in reading mode showing a blank document.
  const restoredMode: Mode = initialDoc?.isNew
    ? "edit"
    : (urlRestore.mode ?? "reading");
  const restoredScrollTop: number = urlRestore.scrollTop ?? 0;

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

  // The initial document was loaded straight into the editor at view-creation
  // time — before `currentPath` (and thus the image cache's doc-path getter)
  // was known. Recompute decorations now so local images in the restored
  // document resolve against the correct directory instead of hanging on the
  // loading placeholder. (Subsequent opens go through loadAndApplyDoc, which
  // sets currentPath before the buffer swap.)
  if (currentPath) view.dispatch({ effects: refreshDecorationsEffect.of() });

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
  // The pages the pane is currently showing, mirrored here so the file-out
  // surfaces (Export → HTML/PDF, Print, Copy as HTML) can export the compiled
  // document rather than re-deriving it. `stale` tracks the same condition as
  // the pane's `.typst-pane-stale` dimming: the newest compile produced no
  // pages, so these are a prior revision's.
  let typstRender: TypstRenderState | null = null;

  async function openTypstSessionIfNeeded(): Promise<void> {
    if (detectFormat(currentPath) !== "typst") {
      // Switched away from typst — tear down any prior session.
      if (typstDriver) {
        await typstDriver.close();
        typstDriver = null;
      }
      typstRender = null;
      toolbar.setStatus(null);
      return;
    }
    if (!currentPath) return;
    // A fresh entry file means the previous document's pages must not be
    // exportable — drop them before the first compile of the new one lands.
    typstRender = null;
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
      // Shell-level failure (session gone, IO). Whatever the pane still shows
      // is no longer known to match the buffer, so it stops being exportable
      // as a faithful render of it.
      if (typstRender) typstRender = { ...typstRender, stale: true };
      toolbar.setStatus(null);
      return;
    }
    // Discard if a newer compile started after we kicked off. The newer
    // compile's own resolution will overwrite the pane.
    if (mySeq !== typstCompileSeq) return;

    if (result.pages.length > 0) {
      previewPane.setPages(result.pages);
      previewPane.body.classList.remove("typst-pane-stale");
      typstRender = { pages: result.pages, stale: false };
    } else {
      // No pages for the current buffer, so whatever the pane still shows is a
      // prior revision's and stops counting as an export of *this* one. Not
      // conditional on an error diagnostic: the pane only dims for errors, but
      // a zero-page compile with no errors would otherwise leave the old pages
      // looking current to an export.
      if (typstRender) typstRender = { ...typstRender, stale: true };
      if (result.diagnostics.some((d) => d.severity === "error")) {
        // Failed compile with prior content — dim it instead of clearing.
        previewPane.body.classList.add("typst-pane-stale");
      }
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

  /** Run any pending debounced compile *now* and wait for it. Exports call this
   * first: the pane can be up to `TYPST_COMPILE_DEBOUNCE_MS` behind the buffer,
   * and an export that silently omits the last keystroke is the same class of
   * quiet infidelity as exporting the wrong language. No-op for Markdown. */
  async function flushTypstCompile(): Promise<void> {
    if (!typstDriver) return;
    if (typstCompileTimer) {
      clearTimeout(typstCompileTimer);
      typstCompileTimer = null;
    }
    await runTypstCompile();
  }

  setDocumentFormatAttr();
  applyPreviewPaneLayout();

  window.addEventListener("beforeunload", () => {
    if (typstDriver) void typstDriver.close();
  });

  // Per-window folder root, held here so the session report tick can read it
  // synchronously. setCurrentFolder() below is the only writer.
  let currentFolder: string | null = null;
  const selfLabel = getCurrentWindow().label;
  let folderWatcherHandle: FolderWatcherHandle | null = null;
  // Skip recents for a brand-new (`md newfile.md`) buffer until first save —
  // otherwise the recents list points at a path that doesn't exist on disk.
  if (currentPath && !initialDoc?.isNew) await recordRecent(currentPath);

  /** Open `root` as the current folder: list .md files in the sidebar and
   * ensure the sidebar is visible. Pass null to clear. The value reaches
   * Rust's window registry on the next session report tick — there is no
   * separate store key for it any more.
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
    await folder.setFolder(root);
    // No announce: Rust's window registry learns this window's folder from the
    // session report tick, and routing reads it from there.
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

  // Every window listens for a targeted open request; Rust's router emits
  // one when it has decided this window owns the file's folder. NOTE: a global
  // `listen()` receives an event regardless of the `emitTo` target — in
  // Tauri v2 `emitTo(label, …)` does NOT restrict delivery to that window's
  // global listeners (verified: an emitTo to one label fired this handler in
  // every open window, opening the file everywhere). So the addressing has to
  // be explicit: the payload carries the intended label and every other
  // window ignores it. Do not "simplify" this back to a bare string payload.
  const unsubTargetedOpen = await listen<{ label: string; path: string }>(
    "viewer:open-file",
    async (e) => {
      const { label, path: md } = e.payload ?? { label: "", path: "" };
      if (label !== selfLabel || !md) return;
      await openWithDirtyPrompt(md);
      await getCurrentWindow().setFocus();
    },
  );
  window.addEventListener("beforeunload", () => unsubTargetedOpen());

  // Rust routed a directory request to this window because our tree contains
  // it. Reveal it in place — the root deliberately does not move. Same
  // label-in-payload addressing as viewer:open-file (see #145 above).
  const unsubReveal = await listen<{ label: string; path: string }>(
    "viewer:reveal-path",
    (e) => {
      const { label, path } = e.payload ?? { label: "", path: "" };
      if (label !== selfLabel || !path) return;
      folder.revealDirectory(path);
    },
  );
  window.addEventListener("beforeunload", () => unsubReveal());

  // Rust adopted this blank window into a project. One message, not two: when
  // the adoption carries a document, `path` is set and the project-fallback
  // buffer is skipped. Sent as two events (adopt, then open) the fallback
  // would race the requested file through two unrelated async listeners and
  // usually win — the user asked for notes.md and got README.md.
  const unsubAdoptFolder = await listen<{
    label: string;
    folder: string;
    path?: string | null;
  }>("viewer:adopt-folder", (e) => {
    const payload = e.payload;
    if (payload?.label !== selfLabel) return;
    void (async () => {
      // Adopting the folder is best-effort: it can reject on canonicalize /
      // recents bookkeeping, and when it does the user still asked for a
      // document. Opening it must not depend on the sidebar succeeding —
      // before these two events were collapsed into one message they were
      // independent listeners, and that resilience is worth keeping.
      try {
        await setCurrentFolder(payload.folder, { replaceBuffer: !payload.path });
      } catch (err) {
        console.warn("adopt folder failed", err);
      }
      if (payload.path) await openWithDirtyPrompt(payload.path);
      await getCurrentWindow().setFocus();
    })();
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

  // Initial folder: the ?folder= parameter Rust set on this window's URL, or
  // — when only a file was given — the file's own tree. A window that got
  // neither stays folderless; there is no store key to fall back on any more,
  // because "which folder does this window show" is now session state Rust
  // hands us rather than a global the frontend re-derives.
  //
  // Applying it is asynchronous (it canonicalizes over IPC), and until it
  // finishes `currentFolder` is null even for a window Rust restored into a
  // project. Reporting that would overwrite the registry entry Rust seeded
  // synchronously with `folder: null` — and a window with no folder and no
  // document reads as blank, which is precisely the state an external
  // `md <other-dir>` is allowed to adopt. So gate the reporter on this
  // finishing rather than letting it publish a state we haven't reached yet.
  let sessionStateReady = false;
  void (async () => {
    try {
      if (initialFolder) await setCurrentFolder(initialFolder);
      else if (currentPath) await syncFolderToFile(currentPath);
      // A directory Rust routed to this window at launch: expand it in the
      // tree without moving the root. The warm equivalent is the
      // `viewer:reveal-path` event; a window that doesn't exist yet can only
      // be told through its URL.
      const reveal = revealFromUrlQuery();
      if (reveal) folder.revealDirectory(reveal);
    } catch {
      // Folder unreadable / disappeared between the launch plan and this
      // window booting — leave the panel hidden.
    } finally {
      sessionStateReady = true;
    }
  })();
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

  // Report this window's state to Rust on a periodic tick. Rust owns the
  // session: the registry it keeps is what routing consults while the app is
  // running and what the next launch restores from. Closing one window of
  // several drops just that window (close.ts calls `forgetWindow`); Cmd-Q
  // preserves all, since the last tick is the state that survives. Installed
  // here rather than earlier in bootstrap because the reporter reads
  // `dirtyTracker` — which does not exist until the line above.
  const stopSessionReporting = installSessionReporting({
    ready: () => sessionStateReady,
    currentPath: () => currentPath,
    folder: () => currentFolder,
    dirty: () => dirtyTracker.isDirty(),
    scrollTop: () => view.scrollDOM.scrollTop,
    mode: () => currentMode,
    sidebarVisible: () => toc.isVisible(),
  });
  window.addEventListener("beforeunload", () => stopSessionReporting());
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

  async function loadAndApplyDoc(
    path: string,
    opts: { fromLink: boolean } = { fromLink: false },
  ): Promise<void> {
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
    // Point the image cache at the new document and drop the previous
    // document's decoded blobs *before* the buffer swap, so the decoration
    // recompute triggered by this change resolves local images against the new
    // document's directory on its first pass (no stale-path round-trip).
    currentPath = doc.path;
    localImageCache.releaseExcept(doc.path);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc.source },
    });
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
      await maybeRestorePositionFor(currentPath, { fromLink: opts.fromLink });
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
  async function openWithDirtyPrompt(
    path: string,
    opts: { fromLink: boolean } = { fromLink: false },
  ): Promise<void> {
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
    await loadAndApplyDoc(path, opts);
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
        // Following an internal Markdown link always opens the target at the
        // top with no highlighted section, regardless of any saved position
        // for that file (issue #161).
        await openWithDirtyPrompt(absPath, { fromLink: true });
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
  /**
   * Build the HTML that every file-out surface hands to its sink — Export →
   * HTML, Export → PDF, Print, and Copy as HTML all go through here.
   *
   * This must branch on the document's format, and returns `null` when there is
   * nothing faithful to hand over (having already told the user why). Until
   * #57 it called `buildHtmlExport` unconditionally, which is the markdown-it
   * pipeline: with a `.typ` open, all four surfaces ran the Typst *source*
   * through a Markdown renderer — `= Heading` came out as a paragraph of prose,
   * `#import` / `#set` / `#figure(…)` as more prose — and wrote that into a file
   * the dialog had already named `document.pdf`, while the correctly compiled
   * pages sat in the preview pane. `decideExportRoute` is the one place that
   * decision now lives, and it is unit-tested (`tests/export/route.test.ts`).
   */
  const buildCurrentHtml = async (): Promise<string | null> => {
    // Typst pages can be a debounce behind the buffer; catch up before deciding.
    await flushTypstCompile();
    const route = decideExportRoute({
      format: detectFormat(currentPath),
      typstRender,
    });
    const title = documentTitleFromPath(currentPath);
    switch (route.kind) {
      case "markdown":
        return await buildHtmlExport(view.state.doc.toString(), { title });
      case "typst":
        return buildTypstHtmlExport(route.pages, { title });
      case "blocked":
        await message(
          route.reason === "typst-stale"
            ? t("typst.export.stale")
            : t("typst.export.not_compiled"),
          { title: t("typst.export.title") },
        );
        return null;
    }
  };
  const localHandlers: LocalMenuHandlers = {
    openFile: async () => {
      const doc = await openFileViaDialog();
      if (doc) await loadAndApplyDoc(doc.path);
    },
    openFolder: async () => {
      const root = await pickFolder();
      // Route through Rust's focus/adopt/spawn logic so Open Folder honors the
      // 1:1 folder↔window mapping (#100).
      if (root) await requestOpen([root], selfLabel);
    },
    newWindow: async () => { await requestNewWindow(); },
    saveFile: () => { void triggerSave(); },
    saveFileAs: async () => {
      // Save As keeps the document's format. It used to default to `.md` with
      // a Markdown-only filter for every document, so saving an open `.typ`
      // under a new name converted it to Markdown identity and it reopened as
      // Markdown next time.
      const format = detectFormat(currentPath);
      const defaultName = exportFileNameFromPath(
        currentPath,
        saveAsExtension(format),
      );
      const dest = await saveDocumentAs(
        format,
        view.state.doc.toString(),
        defaultName,
      );
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
      // The Typst session's entry file is the *old* path, so relative
      // `#import "./sibling.typ"` and image paths would keep resolving against
      // the old directory. Re-open against dest.
      if (format === "typst") await openTypstSessionIfNeeded();
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
    // All four file-out surfaces bail on a null build — `buildCurrentHtml` has
    // already told the user why, and the alternative is naming a destination
    // for a document that doesn't exist.
    exportHtml: async () => {
      const html = await buildCurrentHtml();
      if (html === null) return;
      const defaultName = exportFileNameFromPath(currentPath, "html");
      await saveHtmlExport(html, defaultName);
    },
    exportPdf: async () => {
      const html = await buildCurrentHtml();
      if (html === null) return;
      const defaultName = exportFileNameFromPath(currentPath, "pdf");
      await savePdfExport(html, defaultName);
    },
    printDocument: () => {
      void (async () => {
        const html = await buildCurrentHtml();
        if (html === null) return;
        openPrintWindow(html);
      })();
    },
    copyAsHtml: async () => {
      const html = await buildCurrentHtml();
      if (html === null) return;
      await writeClipboardHtml(html);
    },
    openPreferences: async () => {
      await openPreferences();
    },
    showKeyboardShortcuts: () => { void openKeyboardShortcuts(); },
    openProject: async (path) => {
      // Don't switch in place — let Rust route to the right window (focus
      // existing / adopt here / spawn new). See issue #100.
      await requestOpen([path], selfLabel);
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


  // Exactly one window owns the app menu. If every window installed it each
  // one would clobber the previous handlers (last writer wins on macOS),
  // which is exactly what produced the "Cmd-W closes the most recently
  // opened window" bug. With one owner, routing via emitTo to the focused
  // window is deterministic.
  //
  // The owner is *elected*, not named: windows are restored under their
  // recorded labels, so a session may legitimately contain no window called
  // `main` — close it with the red X and quit, and the next launch restores
  // `{window-2}`. Gating on the label there meant the menu was never built
  // for the whole session, with no recovery short of deleting session.json.
  // Rust hands ownership to the first window that asks, and re-elects when
  // the owner is deliberately closed.
  let menuInstalled = false;
  const installAppMenu = async (): Promise<void> => {
    if (menuInstalled) return;
    menuInstalled = true;
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
      exportPdf: () => dispatchToFocused({ type: "exportPdf" }),
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
  };

  // Re-election: the previous owner was closed and Rust picked us. Arrives
  // long after boot, so the listener goes in before the claim.
  const unsubClaimMenu = await listen<{ label: string }>("viewer:claim-menu", (e) => {
    if (e.payload?.label !== selfLabel) return;
    void installAppMenu();
  });
  window.addEventListener("beforeunload", () => unsubClaimMenu());
  if (await claimMenu(selfLabel)) await installAppMenu();

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

    // Single-path drop of a directory: hand it to the router, same as Open
    // Folder and Switch Project, so a folder already shown elsewhere raises
    // that window instead of opening a second copy of it here.
    if (paths.length === 1 && (await isDirectory(paths[0]))) {
      await requestOpen(paths, selfLabel);
      return;
    }

    const docFiles = paths.filter((p) => isSupportedExtension(p));
    if (docFiles.length === 0) return;

    // Hand the whole batch to Rust's router, which routes each path against
    // the registry as updated by the previous one. Files sharing a folder land
    // in one window rather than spawning a window each.
    await requestOpen(docFiles, selfLabel);
  });
  window.addEventListener("beforeunload", () => unsubDrop());

  await setWindowTitle(initialDoc?.path ?? null, false, currentFolder);

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
  /** Folder to open as sidebar root — the window's `?folder=` parameter.
   * Independent from `doc`: a window may be rooted at a project with no
   * document to show. */
  folder: string | null;
}

/**
 * Every window's initial state arrives as URL parameters set by Rust's
 * `session::window_url`. The frontend decides nothing: recovery pairing,
 * session restore, launch arguments and project fallback ordering are all
 * resolved in `src-tauri/src/session/launch.rs` before this window exists.
 */
async function resolveInitial(): Promise<InitialResolution> {
  const folder = folderFromUrlQuery();
  const file = fileFromUrlQuery();

  // Crash recovery is still resolved in the frontend (see
  // `maybeRestoreFromRecovery`) and its buffer outranks whatever the window
  // was planned to show, because it is the only copy of the user's unsaved
  // edits. Rust pairs a dump with the window that owns its file and forwards
  // it as `?dump=`; `recoveredDoc` is only ever set from the dump this window
  // was handed, so returning it here can't clobber the `?file=`/`?folder=`
  // plan for some other window.
  if (recoveredDoc) return { doc: recoveredDoc, folder };

  if (file) {
    try {
      return { doc: await readDoc(file), folder };
    } catch {
      // Deleted between the launch plan and this window booting — fall through
      // to the project fallback chain rather than showing an error.
    }
  }
  if (folder) {
    const fallback = await resolveProjectFallbackFile(folder);
    if (fallback) {
      try {
        return { doc: await readDoc(fallback), folder };
      } catch {
        // Listed but unreadable — welcome buffer inside the project.
      }
    }
    return { doc: null, folder };
  }
  return { doc: null, folder: null };
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

/** A directory Rust wants expanded in this window's tree on boot, without
 *  moving its root — the URL-borne form of `viewer:reveal-path`, used when
 *  the routing decision was taken before this window existed. */
function revealFromUrlQuery(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const r = params.get("reveal");
    return r && r.length > 0 ? r : null;
  } catch {
    return null;
  }
}

function dumpFromUrlQuery(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const d = params.get("dump");
    return d && d.length > 0 ? d : null;
  } catch {
    return null;
  }
}

/** Read the optional ?mode=, ?scrollTop= and ?sidebar= URL params Rust sets
 *  when it creates a window, so a restored window comes back in the mode,
 *  at the position, and with the sidebar visibility it was left. All three
 *  may be absent; all are validated. `sidebarVisible` is `null` when the
 *  param is absent — distinct from an explicit `false` — so the caller can
 *  fall back to its own heuristic only when there's no recorded preference. */
function restoreParamsFromUrl(): {
  mode: WindowMode | null;
  scrollTop: number | null;
  sidebarVisible: boolean | null;
} {
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
    const sidebarRaw = params.get("sidebar");
    const sidebarVisible: boolean | null =
      sidebarRaw === "true" ? true : sidebarRaw === "false" ? false : null;
    return { mode, scrollTop, sidebarVisible };
  } catch {
    return { mode: null, scrollTop: null, sidebarVisible: null };
  }
}

function defaultPlaceholder(): string {
  return t("welcome.placeholder");
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
