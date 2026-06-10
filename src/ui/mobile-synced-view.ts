// Per-paired-desktop view on the phone. Lists synced files, exposes a
// "Sync now" button, and auto-triggers sync on app resume,
// pull-to-refresh, and a 60s timer while the view is mounted and the
// app is foregrounded. Tap a file to open it.
//
// Per-pair throttle state lives in module scope so a "resume + manual
// tap" can't double-fire: a sync is skipped if one is already in flight
// for the pair, or if the previous successful sync finished <5s ago.

import { tA11y, t } from "../i18n/strings";
import { isMobile } from "../platform";
import {
  type MobilePairing,
  type SyncedFile,
  syncNow,
  listSyncedFiles,
  syncedFolderLabels,
  unpairMobile,
} from "../shell/mobile-pairings";
import { LIVE_OP_EVENT, CAUGHT_UP_EVENT } from "../shell/mobile-sync-client";
import { buildTree, childrenAt, flattenForSearch } from "./mobile-file-tree";
import type { FileTree, FileLeaf, SearchEntry, DirNode } from "./mobile-file-tree";
import { scoreMatch, buildHighlightedSpans } from "./fuzzy";

/** Where the user is in the drill-in browser. `folderIdHex === null` is the
 * projects level (only reachable when the pairing has >1 synced folder). */
export interface SyncedPath {
  folderIdHex: string | null;
  segments: string[];
}

export interface MobileSyncedHandlers {
  /** `path` is where the user was when they opened the file, so the router
   * can restore it on back. */
  onOpenFile: (file: SyncedFile, path: SyncedPath) => void;
  onBack: () => void;
  onUnpaired: () => void;
}

/** Handle returned by mountMobileSynced. `handleBack` pops one browse level
 * (or closes the search overlay) and returns true if it consumed the action;
 * false means "already at the top — router should go to the library". */
export interface MobileSyncedHandle {
  teardown: () => void;
  handleBack: () => boolean;
}

// Per-pair throttle / in-flight state, keyed by pair_id_hex. Module-scoped
// so the timer / focus / pull triggers all consult the same record.
const syncState = new Map<
  string,
  { inFlight: boolean; lastSuccessMs: number }
>();

/** Minimum gap between two successful syncs for the same pair, in ms.
 *  Stops resume-then-pull double-fire from hitting the desktop twice. */
const THROTTLE_MS = 5_000;
/** Periodic poll interval. 60s is the issue-#97 recommendation —
 *  fresh enough to feel live, low enough to not drain battery. */
const POLL_INTERVAL_MS = 60_000;

export async function mountMobileSynced(
  root: HTMLElement,
  pairing: MobilePairing,
  handlers: MobileSyncedHandlers,
  initialPath?: SyncedPath,
): Promise<MobileSyncedHandle> {
  root.innerHTML = "";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "mobile-document__back";
  backBtn.textContent = "← " + t("mobile.library.back");
  // backBtn's click handler is wired below, after handleBack is defined.
  root.appendChild(backBtn);

  const wrap = document.createElement("div");
  wrap.className = "mobile-library";

  const title = document.createElement("h1");
  title.className = "mobile-library__title";
  title.textContent = pairing.friendly_name || pairing.pair_id_hex.slice(0, 12);
  wrap.appendChild(title);

  const sub = document.createElement("p");
  sub.className = "mobile-library__empty";
  sub.style.opacity = "0.55";
  sub.style.fontSize = "0.8rem";
  sub.style.fontFamily = "var(--font-mono, ui-monospace, monospace)";
  sub.textContent = pairing.verification_fingerprint;
  wrap.appendChild(sub);

  const actions = document.createElement("div");
  actions.className = "mobile-synced__actions";
  wrap.appendChild(actions);

  const syncBtn = document.createElement("button");
  syncBtn.type = "button";
  syncBtn.className = "mobile-library__pair-cta";
  syncBtn.textContent = t("mobile.synced.sync_now");
  actions.appendChild(syncBtn);

  const unpairBtn = document.createElement("button");
  unpairBtn.type = "button";
  unpairBtn.className =
    "mobile-library__pair-cta mobile-library__pair-cta--secondary mobile-synced__unpair";
  unpairBtn.textContent = t("mobile.synced.unpair");
  actions.appendChild(unpairBtn);

  // Status line: live status during a sync, "Synced Xs ago" afterwards.
  const status = document.createElement("p");
  status.className = "mobile-library__empty";
  status.style.minHeight = "1.4em";
  wrap.appendChild(status);

  // Pull-to-refresh affordance: a small hint that appears as the user
  // drags the list downward past a threshold.
  const pullHint = document.createElement("p");
  pullHint.className = "mobile-library__empty";
  pullHint.style.minHeight = "1.4em";
  pullHint.style.transition = "opacity 0.15s";
  pullHint.style.opacity = "0";
  pullHint.textContent = t("mobile.synced.pull_hint");
  wrap.appendChild(pullHint);

  // Breadcrumb / level header rendered above the list.
  const crumb = document.createElement("div");
  crumb.className = "mobile-browse__crumb";
  wrap.appendChild(crumb);

  const list = document.createElement("ul");
  list.className = "mobile-library__list";
  wrap.appendChild(list);

  root.appendChild(wrap);

  // Search button lives in the back-bar row.
  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.className = "mobile-browse__search-btn";
  searchBtn.setAttribute("aria-label", t("mobile.browse.search_label"));
  searchBtn.textContent = "🔍";
  searchBtn.addEventListener("click", () => openSearch());
  root.insertBefore(searchBtn, wrap); // top-right; positioned via CSS

  // Track whether at least one successful sync has happened during this
  // mount so we can render the "synced Xs ago" line accurately.
  let lastDisplayedSuccessMs: number | null = null;
  let statusTickHandle: ReturnType<typeof setInterval> | null = null;

  // Drill-in browse state. tree is rebuilt from the store on every refresh().
  let tree: FileTree = { folders: [] };
  let path: SyncedPath = initialPath ?? { folderIdHex: null, segments: [] };

  const renderRelativeStatus = (): void => {
    const existing = syncState.get(pairing.pair_id_hex);
    if (existing?.inFlight) return; // Don't clobber "Syncing…".
    const lastMs = lastDisplayedSuccessMs ?? existing?.lastSuccessMs ?? 0;
    if (!lastMs) {
      status.textContent = t("mobile.synced.never_synced");
      return;
    }
    const ago = Date.now() - lastMs;
    if (ago < 5_000) {
      status.textContent = t("mobile.synced.last_synced_just_now");
    } else if (ago < 60_000) {
      status.textContent = tA11y("mobile.synced.last_synced_seconds", {
        n: String(Math.floor(ago / 1_000)),
      });
    } else if (ago < 3_600_000) {
      status.textContent = tA11y("mobile.synced.last_synced_minutes", {
        n: String(Math.floor(ago / 60_000)),
      });
    } else {
      status.textContent = tA11y("mobile.synced.last_synced_hours", {
        n: String(Math.floor(ago / 3_600_000)),
      });
    }
  };

  const refresh = async (): Promise<void> => {
    const files = await listSyncedFiles(pairing.pair_id_hex);
    const labels = await syncedFolderLabels(pairing.pair_id_hex);
    // Map the store's snake_case SyncedFile shape to the tree module's
    // camelCase TreeInputFile at the boundary (the pure module stays
    // independent of store naming).
    tree = buildTree(
      files.map((x) => ({
        folderIdHex: x.folder_id_hex,
        relpath: x.relpath,
        syncedAtUnix: x.synced_at_unix,
      })),
      labels,
    );

    if (files.length === 0 && lastDisplayedSuccessMs === null) {
      // Only show the "no synced files yet" hint before the first sync;
      // once we've synced and still have zero files, the relative-time
      // status line is more informative than re-stating empty state.
      status.textContent = t("mobile.synced.empty");
    }

    // If the pairing has exactly one folder and we're at the projects level,
    // drop straight into that folder's root.
    if (path.folderIdHex === null && tree.folders.length === 1) {
      path = { folderIdHex: tree.folders[0].folderIdHex, segments: [] };
    }
    // If our current path vanished (e.g. live delete), pop to nearest ancestor.
    normalizePath();
    renderLevel();
  };

  /** Pop trailing segments until the path resolves, then drop to projects
   * level if even the folder is gone. */
  function normalizePath(): void {
    if (path.folderIdHex === null) return;
    // Capture the non-null folderIdHex for the type-narrowed loop.
    let fid: string = path.folderIdHex;
    while (childrenAt(tree, fid, path.segments) === null) {
      if (path.segments.length > 0) {
        path = { folderIdHex: fid, segments: path.segments.slice(0, -1) };
      } else {
        path = { folderIdHex: null, segments: [] };
        // Re-apply single-folder skip after a reset.
        if (tree.folders.length === 1) {
          path = { folderIdHex: tree.folders[0].folderIdHex, segments: [] };
        }
        return;
      }
    }
  }

  function renderLevel(): void {
    list.innerHTML = "";
    crumb.innerHTML = "";

    // Show sync controls (Sync now, Unpair, status, pull hint) only at the
    // level where they are actionable: the projects level (multi-folder
    // pairings) or the single-folder root (when the projects level is skipped).
    const atSyncControlLevel =
      path.folderIdHex === null ||
      (tree.folders.length === 1 && path.segments.length === 0);
    actions.style.display = atSyncControlLevel ? "" : "none";
    status.style.display = atSyncControlLevel ? "" : "none";
    pullHint.style.display = atSyncControlLevel ? "" : "none";

    if (path.folderIdHex === null) {
      // Projects level: list synced folders.
      crumb.textContent = pairing.friendly_name || pairing.pair_id_hex.slice(0, 12);
      for (const folder of tree.folders) {
        list.appendChild(
          browseRow("dir", folder.label, tA11y("mobile.browse.file_count", { n: String(folder.fileCount) }), () => {
            path = { folderIdHex: folder.folderIdHex, segments: [] };
            renderLevel();
          }),
        );
      }
      return;
    }

    const node = childrenAt(tree, path.folderIdHex, path.segments);
    if (!node) return; // normalizePath guarantees this won't happen
    renderBreadcrumb();

    if (node.dirs.size === 0 && node.files.length === 0) {
      const empty = document.createElement("li");
      empty.className = "mobile-browse__empty";
      empty.textContent = t("mobile.browse.empty_dir");
      list.appendChild(empty);
      return;
    }

    for (const [name, child] of node.dirs) {
      list.appendChild(
        browseRow("dir", name, tA11y("mobile.browse.file_count", { n: String(countFiles(child)) }), () => {
          path = { folderIdHex: path.folderIdHex, segments: [...path.segments, name] };
          renderLevel();
        }),
      );
    }
    for (const file of node.files) {
      list.appendChild(
        browseRow("file", file.name, formatRelative(file.syncedAtUnix * 1000), () =>
          handlers.onOpenFile(toSyncedFile(file), path),
        ),
      );
    }
  }

  function renderBreadcrumb(): void {
    // Build clickable crumbs: <folder label> / seg / seg
    const parts: { label: string; segments: string[] }[] = [];
    const folder = tree.folders.find((x) => x.folderIdHex === path.folderIdHex);
    parts.push({ label: folder?.label ?? "", segments: [] });
    for (let i = 0; i < path.segments.length; i++) {
      parts.push({ label: path.segments[i], segments: path.segments.slice(0, i + 1) });
    }
    crumb.innerHTML = "";
    parts.forEach((part, idx) => {
      if (idx > 0) crumb.appendChild(document.createTextNode(" / "));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mobile-browse__crumb-btn";
      btn.textContent = part.label;
      btn.addEventListener("click", () => {
        path = { folderIdHex: path.folderIdHex, segments: part.segments };
        renderLevel();
      });
      crumb.appendChild(btn);
    });
  }

  function browseRow(
    kind: "dir" | "file",
    name: string,
    meta: string,
    onActivate: () => void,
  ): HTMLLIElement {
    const li = document.createElement("li");
    li.className = `mobile-browse__row mobile-browse__row--${kind} mobile-library__item`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mobile-library__item-btn";
    btn.addEventListener("click", onActivate);
    const nameEl = document.createElement("span");
    nameEl.className = "mobile-library__item-name";
    nameEl.textContent = (kind === "dir" ? "📁 " : "") + name;
    const metaEl = document.createElement("span");
    metaEl.className = "mobile-library__item-when";
    metaEl.textContent = meta;
    btn.append(nameEl, metaEl);
    li.appendChild(btn);
    return li;
  }

  /** Recursive total file count under a dir, so a folder/project row's count
   * consistently means "total files inside" (matches the projects level). */
  function countFiles(dir: DirNode): number {
    let n = dir.files.length;
    for (const child of dir.dirs.values()) n += countFiles(child);
    return n;
  }

  /** Reconstruct the store-shaped SyncedFile from a tree leaf for onOpenFile. */
  function toSyncedFile(leaf: FileLeaf): SyncedFile {
    return {
      pair_id_hex: pairing.pair_id_hex,
      folder_id_hex: leaf.folderIdHex,
      relpath: leaf.relpath,
      abs_path: "",
      synced_at_unix: leaf.syncedAtUnix,
    };
  }

  // --- Search overlay --------------------------------------------------------

  let searchOverlay: HTMLElement | null = null;

  function openSearch(): void {
    if (searchOverlay) return;
    const overlay = document.createElement("div");
    overlay.className = "mobile-search";
    searchOverlay = overlay;

    const bar = document.createElement("div");
    bar.className = "mobile-search__bar";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "mobile-search__close";
    closeBtn.setAttribute("aria-label", t("mobile.search.close"));
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", closeSearch);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "mobile-search__input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("mobile.search.placeholder");
    input.setAttribute("aria-label", t("mobile.search.input_label"));
    bar.append(closeBtn, input);

    const results = document.createElement("ul");
    results.className = "mobile-search__results";
    const empty = document.createElement("p");
    empty.className = "mobile-search__empty";
    empty.style.display = "none";
    empty.textContent = t("mobile.search.no_matches");

    overlay.append(bar, results, empty);
    root.appendChild(overlay);

    const render = (): void => {
      // Recompute from the live tree each render so a LIVE_OP_EVENT that
      // rebuilds `tree` while the overlay is open reflects in results.
      const all: SearchEntry[] = flattenForSearch(tree);
      const q = input.value.trim();
      results.innerHTML = "";
      const matched =
        q.length === 0
          ? all.map((e) => ({ entry: e, positions: [] as number[], score: 0 }))
          : all
              .map((entry) => {
                const m = scoreMatch(entry.searchKey, q);
                return m ? { entry, positions: m.positions, score: m.score } : null;
              })
              .filter((x): x is { entry: SearchEntry; positions: number[]; score: number } => x !== null)
              .sort((a, b) => b.score - a.score || a.entry.relpath.localeCompare(b.entry.relpath));

      empty.style.display = matched.length === 0 ? "block" : "none";
      for (const { entry, positions } of matched) {
        const li = document.createElement("li");
        li.className = "mobile-search__result mobile-library__item";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mobile-library__item-btn";
        const nameEl = document.createElement("span");
        nameEl.className = "mobile-library__item-name";
        for (const node of buildHighlightedSpans(entry.relpath, positions)) nameEl.append(node);
        const metaEl = document.createElement("span");
        metaEl.className = "mobile-library__item-when";
        metaEl.textContent = entry.label;
        btn.append(nameEl, metaEl);
        const openEntry = () => {
          closeSearch();
          handlers.onOpenFile(
            {
              pair_id_hex: pairing.pair_id_hex,
              folder_id_hex: entry.folderIdHex,
              relpath: entry.relpath,
              abs_path: "",
              synced_at_unix: 0,
            },
            path,
          );
        };
        btn.addEventListener("click", openEntry);
        li.appendChild(btn);
        results.appendChild(li);
      }
    };

    input.addEventListener("input", render);
    render();
    input.focus();
  }

  function closeSearch(): void {
    if (searchOverlay) {
      searchOverlay.remove();
      searchOverlay = null;
    }
  }

  // Inline two-step confirm: first tap arms the button (label changes to
  // "Confirm unpair?"), second tap commits. Tapping anything else or
  // tapping Sync now disarms. No heavy modal.
  const unpairDefaultLabel = t("mobile.synced.unpair");
  const unpairConfirmLabel = t("mobile.synced.unpair_confirm");
  let unpairArmed = false;
  let disarmTimer: number | null = null;
  const disarmUnpair = () => {
    unpairArmed = false;
    unpairBtn.textContent = unpairDefaultLabel;
    unpairBtn.classList.remove("mobile-synced__unpair--armed");
    if (disarmTimer !== null) {
      window.clearTimeout(disarmTimer);
      disarmTimer = null;
    }
  };

  unpairBtn.addEventListener("click", async () => {
    if (!unpairArmed) {
      unpairArmed = true;
      unpairBtn.textContent = unpairConfirmLabel;
      unpairBtn.classList.add("mobile-synced__unpair--armed");
      // Auto-disarm after 4s so a stray tap doesn't sit armed forever.
      disarmTimer = window.setTimeout(disarmUnpair, 4000);
      return;
    }
    disarmUnpair();
    unpairBtn.disabled = true;
    syncBtn.disabled = true;
    try {
      await unpairMobile(pairing.pair_id_hex);
      handlers.onUnpaired();
    } catch (err) {
      status.textContent =
        t("mobile.synced.unpair_failed_prefix") + String(err);
      unpairBtn.disabled = false;
      syncBtn.disabled = false;
    }
  });

  /** Run a sync for this pair, honoring throttle + in-flight rules.
   *  Returns true if a sync was attempted (regardless of outcome). */
  const runSync = async (opts: {
    source: "manual" | "resume" | "pull" | "timer";
    host?: string;
  }): Promise<boolean> => {
    const existing = syncState.get(pairing.pair_id_hex) ?? {
      inFlight: false,
      lastSuccessMs: 0,
    };
    if (existing.inFlight) return false;
    if (
      opts.source !== "manual" &&
      Date.now() - existing.lastSuccessMs < THROTTLE_MS
    ) {
      return false;
    }

    // Resolve a host. Manual flow prompts; auto-sync silently skips when
    // no host is known — we will not pop a prompt on resume/timer.
    let host = opts.host ?? pairing.last_host;
    if (!host) {
      if (opts.source === "manual") {
        const entered = window.prompt(t("mobile.synced.prompt_host"), "");
        if (!entered) return false;
        host = entered;
      } else {
        return false;
      }
    }

    syncState.set(pairing.pair_id_hex, {
      inFlight: true,
      lastSuccessMs: existing.lastSuccessMs,
    });
    syncBtn.disabled = true;
    status.textContent = t("mobile.synced.syncing");

    try {
      await syncNow(pairing.pair_id_hex, host);
      const now = Date.now();
      lastDisplayedSuccessMs = now;
      syncState.set(pairing.pair_id_hex, {
        inFlight: false,
        lastSuccessMs: now,
      });
      await refresh();
      renderRelativeStatus();
    } catch (err) {
      syncState.set(pairing.pair_id_hex, {
        inFlight: false,
        lastSuccessMs: existing.lastSuccessMs,
      });
      // Surface failure for manual / pull-to-refresh; for silent auto
      // triggers (resume/timer), don't clobber the relative-time
      // status with red text — log and move on.
      if (opts.source === "manual" || opts.source === "pull") {
        status.textContent = t("mobile.synced.failed_prefix") + String(err);
      } else {
        console.warn("mobile auto-sync failed", opts.source, err);
        renderRelativeStatus();
      }
    } finally {
      syncBtn.disabled = false;
    }
    return true;
  };

  syncBtn.addEventListener("click", () => {
    disarmUnpair();
    void runSync({ source: "manual" });
  });

  // --- Auto-sync triggers (mobile-only) -----------------------------------

  const cleanups: Array<() => void> = [];

  const onLiveOp = (e: Event) => {
    const ev = e as CustomEvent<{ pairIdHex: string }>;
    if (ev.detail.pairIdHex !== pairing.pair_id_hex) return;
    void refresh();
  };
  const onCaughtUp = (e: Event) => {
    const ev = e as CustomEvent<{ pairIdHex: string }>;
    if (ev.detail.pairIdHex !== pairing.pair_id_hex) return;
    const now = Date.now();
    lastDisplayedSuccessMs = now;
    renderRelativeStatus();
  };
  window.addEventListener(LIVE_OP_EVENT, onLiveOp);
  window.addEventListener(CAUGHT_UP_EVENT, onCaughtUp);
  cleanups.push(() => {
    window.removeEventListener(LIVE_OP_EVENT, onLiveOp);
    window.removeEventListener(CAUGHT_UP_EVENT, onCaughtUp);
  });

  if (isMobile()) {
    // Trigger 1: app resume / focus. Use visibilitychange — it fires
    // both for tab/visibility and for Tauri's webview foregrounding.
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void runSync({ source: "resume" });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    cleanups.push(() =>
      document.removeEventListener("visibilitychange", onVisibility),
    );

    // Trigger 3: periodic timer. 60s while mounted + foregrounded.
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void runSync({ source: "timer" });
    }, POLL_INTERVAL_MS);
    cleanups.push(() => clearInterval(interval));

    // Trigger 2: pull-to-refresh on the list area.
    const PULL_THRESHOLD_PX = 70;
    let pullStartY: number | null = null;
    let pulling = false;

    const onTouchStart = (ev: TouchEvent): void => {
      // Only treat as a pull-down when the user is already at the top.
      if (wrap.scrollTop > 0 || window.scrollY > 0) {
        pullStartY = null;
        return;
      }
      pullStartY = ev.touches[0]?.clientY ?? null;
      pulling = false;
    };
    const onTouchMove = (ev: TouchEvent): void => {
      if (pullStartY === null) return;
      const dy = (ev.touches[0]?.clientY ?? pullStartY) - pullStartY;
      if (dy <= 0) {
        pullHint.style.opacity = "0";
        pulling = false;
        return;
      }
      pulling = true;
      const ratio = Math.min(1, dy / PULL_THRESHOLD_PX);
      pullHint.style.opacity = String(ratio);
      pullHint.textContent =
        dy >= PULL_THRESHOLD_PX
          ? t("mobile.synced.pull_release")
          : t("mobile.synced.pull_hint");
    };
    const onTouchEnd = (ev: TouchEvent): void => {
      if (pullStartY === null) {
        pullHint.style.opacity = "0";
        return;
      }
      const dy =
        (ev.changedTouches[0]?.clientY ?? pullStartY) - pullStartY;
      pullHint.style.opacity = "0";
      pullStartY = null;
      if (pulling && dy >= PULL_THRESHOLD_PX) {
        void runSync({ source: "pull" });
      }
      pulling = false;
    };
    wrap.addEventListener("touchstart", onTouchStart, { passive: true });
    wrap.addEventListener("touchmove", onTouchMove, { passive: true });
    wrap.addEventListener("touchend", onTouchEnd, { passive: true });
    wrap.addEventListener("touchcancel", onTouchEnd, { passive: true });
    cleanups.push(() => {
      wrap.removeEventListener("touchstart", onTouchStart);
      wrap.removeEventListener("touchmove", onTouchMove);
      wrap.removeEventListener("touchend", onTouchEnd);
      wrap.removeEventListener("touchcancel", onTouchEnd);
    });

    // Tick the "Synced Xs ago" line once per second so the user gets
    // continuous feedback that auto-sync is alive.
    statusTickHandle = setInterval(renderRelativeStatus, 1_000);
    cleanups.push(() => {
      if (statusTickHandle !== null) clearInterval(statusTickHandle);
    });
  }

  await refresh();

  // Kick off an initial auto-sync on mount so reaching the view from the
  // library feels live without needing to wait 60s. Manual-equivalent
  // for the throttle check (last_host required, throttle still applies).
  if (isMobile() && pairing.last_host) {
    void runSync({ source: "resume" });
  }

  // --- Handle: teardown + handleBack ---------------------------------------

  const handleBack = (): boolean => {
    if (searchOverlay) { closeSearch(); return true; }
    if (path.folderIdHex !== null && path.segments.length > 0) {
      path = { folderIdHex: path.folderIdHex, segments: path.segments.slice(0, -1) };
      renderLevel();
      return true;
    }
    if (path.folderIdHex !== null && tree.folders.length > 1) {
      // Back to the projects level (only when it wasn't skipped).
      path = { folderIdHex: null, segments: [] };
      renderLevel();
      return true;
    }
    return false; // top level — router goes to library
  };

  // Wire the back button now that handleBack is defined.
  backBtn.addEventListener("click", () => {
    if (!handleBack()) handlers.onBack();
  });

  const teardown = (): void => {
    if (disarmTimer !== null) {
      window.clearTimeout(disarmTimer);
      disarmTimer = null;
    }
    closeSearch();
    for (const fn of cleanups) {
      try { fn(); } catch { /* no-op */ }
    }
    // Drop the per-pair throttle/in-flight record on unmount. If the view
    // tears down mid-sync, the in-flight resolve/reject can no longer clear
    // it, so without this a stale `{ inFlight: true }` would make every
    // future auto-sync trigger (and the manual button) silently no-op until
    // app restart. A fresh mount re-creates the record on first sync.
    syncState.delete(pairing.pair_id_hex);
  };

  return { teardown, handleBack };
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return t("mobile.synced.relative_just_now");
  if (minutes < 60)
    return tA11y("mobile.synced.relative_minutes", { n: String(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return tA11y("mobile.synced.relative_hours", { n: String(hours) });
  const days = Math.floor(hours / 24);
  return tA11y("mobile.synced.relative_days", { n: String(days) });
}
