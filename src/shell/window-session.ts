import { getCurrentWindow } from "@tauri-apps/api/window";

import { deleteValue, getValue, listKeys, setValue } from "./store";

/**
 * Multi-window session restore.
 *
 * Each open window writes a `WindowSessionEntry` to a single `windowSession`
 * key in the store on `beforeunload`. On the next launch, the *main* window
 * reads the list and spawns one secondary window per non-main entry; the main
 * window itself uses its own entry to choose which file to reopen (after the
 * recovery prompt and any other higher-priority initial-doc resolution).
 *
 * The contract is intentionally simple:
 *   - The store always contains the *most recent* state per window label.
 *   - On startup we read once, restore, then clear the stale list so that a
 *     subsequent launch (without the prior multi-window session) doesn't keep
 *     resurrecting old windows forever. Currently-open windows will then write
 *     fresh entries on their own beforeunload.
 *   - Per-window record() is best-effort and defensive: failures are logged
 *     but never propagated, so a flaky tauri call can't break window close.
 */

export type WindowMode = "reading" | "edit";

export interface WindowSessionEntry {
  /** Tauri window label, e.g. "main", "window-2". */
  label: string;
  /** Last-loaded markdown file, or null if the window was blank. */
  path: string | null;
  /** Logical pixels (matches LogicalSize/LogicalPosition for setSize/setPosition). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** scrollDOM.scrollTop at time of close, used to restore reading position. */
  scrollTop: number;
  /** Reading vs. edit mode at time of close. */
  mode: WindowMode;
  /** Folder root shown in the sidebar, or null if no folder was open. Optional
   *  so older persisted entries (which didn't carry this field) still load. */
  folder?: string | null;
  /** Whether the sidebar was visible. Optional for the same back-compat
   *  reason as `folder`. Treat absent as "not specified" — callers fall back
   *  to their own default rather than assuming true/false. */
  sidebarVisible?: boolean;
  /** Wall-clock at record time; used for newest-first ordering / debugging. */
  timestampMs: number;
}

interface WindowSession {
  windows: WindowSessionEntry[];
}

const SESSION_KEY = "windowSession";
/** Per-window key prefix. Each window writes only its own entry under
 *  `windowSession:<label>` so simultaneous beforeunload writes from multiple
 *  windows can't clobber each other through a load-modify-save race on a
 *  shared list. The legacy `windowSession` key is still read on load for
 *  backward compatibility with sessions persisted before this change. */
const SESSION_ENTRY_PREFIX = "windowSession:";

function emptySession(): WindowSession {
  return { windows: [] };
}

function entryKey(label: string): string {
  return `${SESSION_ENTRY_PREFIX}${label}`;
}

function isValidEntry(e: unknown): e is WindowSessionEntry {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  // `folder` and `sidebarVisible` are optional. Older entries written before
  // those fields were added must still load — only validate them when present
  // and reject only on a clearly-wrong type.
  const folderOk =
    r.folder === undefined ||
    r.folder === null ||
    typeof r.folder === "string";
  const sidebarOk =
    r.sidebarVisible === undefined || typeof r.sidebarVisible === "boolean";
  return (
    typeof r.label === "string" &&
    (r.path === null || typeof r.path === "string") &&
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.width === "number" &&
    typeof r.height === "number" &&
    typeof r.scrollTop === "number" &&
    (r.mode === "reading" || r.mode === "edit") &&
    folderOk &&
    sidebarOk &&
    typeof r.timestampMs === "number"
  );
}

/** Read the persisted session. Defensive: bad shapes return an empty session.
 *
 *  Reads both the per-window keys (`windowSession:<label>`, the current format)
 *  and the legacy single-key list (`windowSession`, used before the per-window
 *  fix). Per-window entries take precedence on label collision. */
export async function loadWindowSession(): Promise<WindowSession> {
  try {
    const byLabel = new Map<string, WindowSessionEntry>();

    // Per-window keys.
    let keys: string[] = [];
    try {
      keys = await listKeys();
    } catch {
      keys = [];
    }
    for (const k of keys) {
      if (!k.startsWith(SESSION_ENTRY_PREFIX)) continue;
      try {
        const v = await getValue<unknown>(k);
        if (isValidEntry(v)) byLabel.set(v.label, v);
      } catch {
        // skip malformed entry
      }
    }

    // Legacy list — only contributes labels not already covered.
    try {
      const raw = await getValue<unknown>(SESSION_KEY);
      if (raw && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        if (Array.isArray(r.windows)) {
          for (const e of r.windows) {
            if (isValidEntry(e) && !byLabel.has(e.label)) byLabel.set(e.label, e);
          }
        }
      }
    } catch {
      // ignore
    }

    return { windows: [...byLabel.values()] };
  } catch {
    return emptySession();
  }
}

/** Persist the full session list as per-window keys. Used by tests + helpers.
 *  Idempotent: replaces the per-window keys for the entries given, leaves
 *  others alone. To wipe everything use `clearWindowSession`. */
export async function saveWindowSession(session: WindowSession): Promise<void> {
  try {
    for (const e of session.windows) {
      await setValue(entryKey(e.label), e);
    }
  } catch {
    // ignore — store unavailable (e.g. test env without tauri)
  }
}

/** Wipe the session. Called by main once it has consumed the entries to spawn
 *  secondary windows, so they aren't restored a second time on a future
 *  single-window launch. Removes per-window keys *and* the legacy list. */
export async function clearWindowSession(): Promise<void> {
  try {
    let keys: string[] = [];
    try {
      keys = await listKeys();
    } catch {
      keys = [];
    }
    for (const k of keys) {
      if (k.startsWith(SESSION_ENTRY_PREFIX)) {
        try { await deleteValue(k); } catch { /* ignore */ }
      }
    }
    try { await deleteValue(SESSION_KEY); } catch { /* ignore */ }
  } catch {
    // ignore
  }
}

/** Remove a single window's persisted entry — used when a window is closed
 *  individually (e.g. user clicks the close button) so it doesn't get
 *  resurrected on next launch. */
export async function removeWindowSessionEntry(label: string): Promise<void> {
  try {
    await deleteValue(entryKey(label));
  } catch {
    // ignore
  }
}

/** Insert-or-replace an entry by label. Pure function — testable without store. */
export function upsertEntry(
  session: WindowSession,
  entry: WindowSessionEntry,
): WindowSession {
  const others = session.windows.filter((w) => w.label !== entry.label);
  return { windows: [...others, entry] };
}

/** Remove an entry by label. Pure function. */
export function removeEntry(
  session: WindowSession,
  label: string,
): WindowSession {
  return { windows: session.windows.filter((w) => w.label !== label) };
}

export interface RecordWindowStateInput {
  path: string | null;
  scrollTop: number;
  mode: WindowMode;
  folder?: string | null;
  sidebarVisible?: boolean;
}

/**
 * Capture and persist the current window's session entry. Called from
 * `beforeunload`. Best-effort: any failure (no tauri, no store) is swallowed
 * so a flaky call can't block window close.
 */
export async function recordCurrentWindowState(
  input: RecordWindowStateInput,
): Promise<void> {
  try {
    const win = getCurrentWindow();
    const label = win.label;
    const size = await win.outerSize();
    const pos = await win.outerPosition();
    const factor = await win.scaleFactor();
    const entry: WindowSessionEntry = {
      label,
      path: input.path,
      width: Math.round(size.width / factor),
      height: Math.round(size.height / factor),
      x: Math.round(pos.x / factor),
      y: Math.round(pos.y / factor),
      scrollTop: Math.max(0, Math.round(input.scrollTop)),
      mode: input.mode,
      folder: input.folder ?? null,
      sidebarVisible: input.sidebarVisible,
      timestampMs: Date.now(),
    };
    // Write only this window's key — never load-modify-save the shared list.
    // Two windows firing beforeunload at the same time on Cmd+Q would
    // otherwise both load the same baseline and overwrite each other's entry.
    await setValue(entryKey(label), entry);
  } catch {
    // ignore
  }
}

/**
 * Install per-window state persistence.
 *
 * Cmd+Q shutdown is too tight for an async `beforeunload` IPC to land on
 * disk reliably (it fires fire-and-forget; Store.save() finishes after the
 * process is gone). Tauri's `onCloseRequested` handler can preventDefault
 * and await, but in practice with multiple windows on Cmd+Q the macOS
 * terminate sequence still races the await. So instead we save state
 * proactively while the window is alive: an immediate write on register,
 * a periodic write on a short interval, and a best-effort final write on
 * close-requested + beforeunload.
 *
 * Returns an unsubscribe function.
 */
const SESSION_TICK_MS = 1500;

export function installWindowSessionPersistence(getters: {
  currentPath: () => string | null;
  scrollTop: () => number;
  mode: () => WindowMode;
  /** Optional — only windows that show a folder sidebar need to supply this.
   *  Returning null indicates no folder is open. */
  folder?: () => string | null;
  /** Optional — same reason as `folder`. */
  sidebarVisible?: () => boolean;
}): () => void {
  const recordNow = (): Promise<void> =>
    recordCurrentWindowState({
      path: getters.currentPath(),
      scrollTop: getters.scrollTop(),
      mode: getters.mode(),
      folder: getters.folder?.() ?? null,
      sidebarVisible: getters.sidebarVisible?.(),
    });

  // Immediate write so even an instant-quit after launch still has state.
  void recordNow();

  // Periodic write — keeps scrollTop/mode/path fresh during the session.
  const interval = window.setInterval(() => { void recordNow(); }, SESSION_TICK_MS);

  // Quit-vs-close: when the user closes one window of several, drop that
  // window from the restore-on-next-launch set. When the user picks Quit
  // (Cmd-Q), the Rust side has already flipped a flag so we preserve every
  // window's entry. `is_quitting` is the IPC that exposes it.
  let unlisten: (() => void) | null = null;
  let alreadyClosing = false;
  const win = getCurrentWindow();
  void win.onCloseRequested(async (event) => {
    if (alreadyClosing) return;
    alreadyClosing = true;
    event.preventDefault();
    let quitting = false;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      quitting = await invoke<boolean>("is_quitting");
    } catch {
      // No is_quitting handler (older backend) — preserve the entry, since
      // that matches the prior trunk behaviour of always saving.
      quitting = true;
    }
    if (quitting) {
      try { await recordNow(); } catch { /* ignore */ }
    } else {
      try { await removeWindowSessionEntry(win.label); } catch { /* ignore */ }
    }
    try { await win.destroy(); } catch { /* ignore */ }
  }).then((u) => { unlisten = u; });

  // beforeunload is the last-line backstop. It fires fire-and-forget for both
  // the user-close and the quit paths; the periodic tick (above) is the
  // primary guarantor of fresh state, so beforeunload only needs to nudge a
  // final write. On the user-close path the close-requested handler has
  // already removed the entry, but a redundant recordNow here would re-add
  // it before destroy lands — so we no-op on the close path by reading the
  // alreadyClosing flag.
  const beforeunloadHandler = (): void => {
    if (alreadyClosing) return;
    void recordNow();
  };
  window.addEventListener("beforeunload", beforeunloadHandler);

  return () => {
    window.clearInterval(interval);
    window.removeEventListener("beforeunload", beforeunloadHandler);
    unlisten?.();
  };
}
