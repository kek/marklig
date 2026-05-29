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

export interface MobileSyncedHandlers {
  onOpenFile: (file: SyncedFile) => void;
  onBack: () => void;
  onUnpaired: () => void;
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
): Promise<() => void> {
  root.innerHTML = "";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "mobile-document__back";
  backBtn.textContent = "← " + t("mobile.library.back");
  backBtn.addEventListener("click", () => handlers.onBack());
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

  const list = document.createElement("ul");
  list.className = "mobile-library__list";
  wrap.appendChild(list);

  root.appendChild(wrap);

  // Track whether at least one successful sync has happened during this
  // mount so we can render the "synced Xs ago" line accurately.
  let lastDisplayedSuccessMs: number | null = null;
  let statusTickHandle: ReturnType<typeof setInterval> | null = null;

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
    list.innerHTML = "";
    if (files.length === 0 && lastDisplayedSuccessMs === null) {
      // Only show the "no synced files yet" hint before the first sync;
      // once we've synced and still have zero files, the relative-time
      // status line is more informative than re-stating empty state.
      status.textContent = t("mobile.synced.empty");
    }
    // Group by folder for readability.
    const byFolder = new Map<string, SyncedFile[]>();
    for (const f of files) {
      const arr = byFolder.get(f.folder_id_hex) ?? [];
      arr.push(f);
      byFolder.set(f.folder_id_hex, arr);
    }
    for (const [folderId, items] of byFolder) {
      const header = document.createElement("h2");
      header.className = "mobile-library__section";
      header.textContent = labels[folderId] ?? folderId.slice(0, 8);
      list.appendChild(header);
      for (const file of items.sort((a, b) =>
        a.relpath.localeCompare(b.relpath),
      )) {
        const li = document.createElement("li");
        li.className = "mobile-library__item";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mobile-library__item-btn";
        btn.addEventListener("click", () => handlers.onOpenFile(file));

        const name = document.createElement("span");
        name.className = "mobile-library__item-name";
        name.textContent = file.relpath;
        const when = document.createElement("span");
        when.className = "mobile-library__item-when";
        when.textContent = formatRelative(file.synced_at_unix * 1000);

        btn.appendChild(name);
        btn.appendChild(when);
        li.appendChild(btn);
        list.appendChild(li);
      }
    }
  };

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

  return () => {
    // Clear the two-tap-confirm timer on teardown so it can't fire against a
    // detached DOM subtree (and keep the closure pinning it) after the route
    // changes while the button is armed.
    if (disarmTimer !== null) {
      window.clearTimeout(disarmTimer);
      disarmTimer = null;
    }
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* no-op */
      }
    }
    // Drop the per-pair throttle/in-flight record on unmount. If the view
    // tears down mid-sync, the in-flight resolve/reject can no longer clear
    // it, so without this a stale `{ inFlight: true }` would make every
    // future auto-sync trigger (and the manual button) silently no-op until
    // app restart. A fresh mount re-creates the record on first sync.
    syncState.delete(pairing.pair_id_hex);
  };
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
