import { StateEffect } from "@codemirror/state";

import { isRemoteUrl } from "../../shell/settings";

export type ImageSrcKind = "remote" | "data" | "local";

/** Decide how an `![alt](src)` URL must be loaded.
 *
 * - `remote`  — `http(s)://` or protocol-relative `//host/…`. The webview can
 *   fetch these directly (subject to the remote-image policy).
 * - `data`    — inline `data:` URI. Assigned to `<img src>` verbatim.
 * - `local`   — anything else: a relative or absolute filesystem path. These
 *   CANNOT be assigned to `<img src>` directly — the webview origin is
 *   `tauri://localhost`, so a path like `docs/x.png` resolves against that
 *   origin and 404s. They must be read off disk through the Rust side and
 *   handed to the webview as an object URL. See {@link localImageCache}. */
export function classifyImageSrc(src: string): ImageSrcKind {
  const trimmed = src.trim();
  if (isRemoteUrl(trimmed)) return "remote";
  if (/^data:/i.test(trimmed)) return "data";
  return "local";
}

interface LocalImageEntry {
  status: "ok" | "error";
  /** Object URL for the decoded image bytes when `status === "ok"`. */
  url?: string;
}

/** Guess an image MIME type from a file extension. SVG must be served as
 * `image/svg+xml`; everything else falls back to a generic octet-stream which
 * the browser still sniffs for raster formats. */
function mimeFromPath(path: string): string {
  const clean = path.split(/[?#]/)[0].toLowerCase();
  const ext = clean.slice(clean.lastIndexOf(".") + 1);
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "avif": return "image/avif";
    case "bmp": return "image/bmp";
    case "svg": return "image/svg+xml";
    case "ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}

/** True for paths that resolve without a base directory (POSIX `/…`, Windows
 * `C:\…` or `\\server\…`). Decides whether a request can proceed before any
 * document path is known. */
export function isAbsoluteLike(rawSrc: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(rawSrc);
}

/** Resolve a Markdown image URL to an absolute filesystem path, relative to the
 * open document's directory. Returns null when a relative path is used but no
 * document is open (nothing to resolve against). */
async function resolveLocalPath(
  rawSrc: string,
  docPath: string | null,
): Promise<string | null> {
  // Strip query/fragment — not valid in POSIX filenames — and percent-decode
  // so `My%20File.png` maps to the real on-disk name.
  let cleaned = rawSrc.replace(/[?#].*$/, "");
  try { cleaned = decodeURI(cleaned); } catch { /* keep raw */ }
  const { isAbsolute, dirname, resolve } = await import("@tauri-apps/api/path");
  if (await isAbsolute(cleaned)) return cleaned;
  if (!docPath) return null;
  const baseDir = await dirname(docPath);
  return await resolve(baseDir, cleaned);
}

/** Read a local image off disk (via the Rust `read_image_base64` command) and
 * wrap it in an object URL. Never throws — any failure yields an error entry so
 * the widget can render a broken-image placeholder. */
async function loadLocalImage(
  rawSrc: string,
  docPath: string | null,
): Promise<LocalImageEntry> {
  try {
    const abs = await resolveLocalPath(rawSrc, docPath);
    if (!abs) return { status: "error" };
    const { invoke } = await import("@tauri-apps/api/core");
    const b64 = await invoke<string>("read_image_base64", { path: abs });
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeFromPath(abs) });
    return { status: "ok", url: URL.createObjectURL(blob) };
  } catch {
    return { status: "error" };
  }
}

/** Per-document cache of decoded local images, keyed by `(docPath, rawSrc)`.
 *
 * Mirrors the Shiki / Mermaid async-widget-cache pattern: the synchronous
 * decoration producer reads from the cache; on a miss it kicks off the async
 * disk read and returns a placeholder; the cache fill dispatches
 * {@link localImageCacheEffect} which re-runs the decoration field. The doc
 * path is read lazily through a registered getter so a relative image always
 * resolves against whatever document is open right now.
 *
 * Entries are keyed by document path (not cleared on doc switch) so that an
 * entry computed before the document path was known — or for a previous
 * document — can never be mistaken for the current document's image. This makes
 * the cache insensitive to the order in which the editor is wired up versus the
 * first decoration compute, which is what made the original getter-clearing
 * design hang on "Loading…" in release builds. */
class LocalImageCache {
  private map = new Map<string, LocalImageEntry>();
  private inflight = new Set<string>();
  private listeners = new Set<() => void>();
  private docPathGetter: () => string | null = () => null;

  /** Wire the cache to the live current-document path. Called once at editor
   * setup; the getter is consulted on every access. */
  setDocPathGetter(getter: () => string | null): void {
    this.docPathGetter = getter;
  }

  private keyFor(docPath: string | null, rawSrc: string): string {
    return `${docPath ?? ""} ${rawSrc}`;
  }

  get(rawSrc: string): LocalImageEntry | undefined {
    return this.map.get(this.keyFor(this.docPathGetter(), rawSrc));
  }

  request(rawSrc: string): void {
    const docPath = this.docPathGetter();
    // A relative path can't be resolved until a document is open. Don't cache a
    // failure for it — just wait; a later recompute (once the document path is
    // set) re-requests with a usable docPath. Absolute paths resolve regardless.
    if (!docPath && !isAbsoluteLike(rawSrc)) return;
    const key = this.keyFor(docPath, rawSrc);
    if (this.map.has(key) || this.inflight.has(key)) return;
    this.inflight.add(key);
    void loadLocalImage(rawSrc, docPath).then((entry) => {
      this.inflight.delete(key);
      this.map.set(key, entry);
      for (const l of this.listeners) l();
    });
  }

  /** Revoke object URLs for documents other than the one currently open, so we
   * don't leak blobs across document switches. The current document's entries
   * (keyed by its path) are kept. Called when the open document changes. */
  releaseExcept(docPath: string | null): void {
    const keep = `${docPath ?? ""} `;
    for (const [key, entry] of this.map) {
      if (key.startsWith(keep)) continue;
      if (entry.url) URL.revokeObjectURL(entry.url);
      this.map.delete(key);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export const localImageCache = new LocalImageCache();

/** State effect dispatched when a local image lands in the cache. */
export const localImageCacheEffect = StateEffect.define<void>();
