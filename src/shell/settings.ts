import { getValue, setValue } from "./store";
import type { Format } from "../format";

export type RemoteImagePolicy = "load" | "placeholder" | "off";

const DEFAULT_REMOTE_IMAGE_POLICY: RemoteImagePolicy = "placeholder";
const DEFAULT_AUTO_SAVE: boolean = false;
const DEFAULT_FOLDER_SECTION_OPEN: boolean = true;
const DEFAULT_TOC_SECTION_OPEN: boolean = true;

const DEFAULT_PREVIEW_PANE: Record<Format, boolean> = {
  markdown: false,
  typst: true,
};
const DEFAULT_PREVIEW_PANE_WIDTH = 0.5;
const MIN_PREVIEW_PANE_WIDTH = 0.2;
const MAX_PREVIEW_PANE_WIDTH = 0.8;

const DEFAULT_TYPST_ZOOM = 1.0;
const MIN_TYPST_ZOOM = 0.5;
const MAX_TYPST_ZOOM = 3.0;
const TYPST_ZOOM_STEP = 0.1;

let remoteImagePolicy: RemoteImagePolicy = DEFAULT_REMOTE_IMAGE_POLICY;
let autoSave: boolean = DEFAULT_AUTO_SAVE;
let folderSectionOpen: boolean = DEFAULT_FOLDER_SECTION_OPEN;
let tocSectionOpen: boolean = DEFAULT_TOC_SECTION_OPEN;
let previewPaneOpen: Record<Format, boolean> = { ...DEFAULT_PREVIEW_PANE };
let previewPaneWidth: number = DEFAULT_PREVIEW_PANE_WIDTH;
let typstZoom: number = DEFAULT_TYPST_ZOOM;
const listeners = new Set<() => void>();

export function getRemoteImagePolicy(): RemoteImagePolicy {
  return remoteImagePolicy;
}

export function setRemoteImagePolicy(p: RemoteImagePolicy): void {
  if (remoteImagePolicy === p) return;
  remoteImagePolicy = p;
  void setValue("remoteImagePolicy", p);
  for (const l of listeners) l();
}

export function getAutoSave(): boolean {
  return autoSave;
}

export function setAutoSave(v: boolean): void {
  if (autoSave === v) return;
  autoSave = v;
  void setValue("autoSave", v);
  for (const l of listeners) l();
}

export function getFolderSectionOpen(): boolean {
  return folderSectionOpen;
}

export function setFolderSectionOpen(v: boolean): void {
  if (folderSectionOpen === v) return;
  folderSectionOpen = v;
  void setValue("folderSectionOpen", v);
  for (const l of listeners) l();
}

export function getTocSectionOpen(): boolean {
  return tocSectionOpen;
}

export function setTocSectionOpen(v: boolean): void {
  if (tocSectionOpen === v) return;
  tocSectionOpen = v;
  void setValue("tocSectionOpen", v);
  for (const l of listeners) l();
}

export function getPreviewPaneOpen(format: Format): boolean {
  return previewPaneOpen[format];
}

export function setPreviewPaneOpen(format: Format, v: boolean): void {
  if (previewPaneOpen[format] === v) return;
  previewPaneOpen = { ...previewPaneOpen, [format]: v };
  void setValue("previewPaneOpen", previewPaneOpen);
  for (const l of listeners) l();
}

export function getPreviewPaneWidth(): number {
  return previewPaneWidth;
}

export function setPreviewPaneWidth(v: number): void {
  const clamped = Math.max(MIN_PREVIEW_PANE_WIDTH, Math.min(MAX_PREVIEW_PANE_WIDTH, v));
  if (previewPaneWidth === clamped) return;
  previewPaneWidth = clamped;
  void setValue("previewPaneWidth", clamped);
  for (const l of listeners) l();
}

/** Current Typst preview zoom (1.0 = actual size). Applied as a CSS scale
 * on `.preview-pane-body[data-format="typst"]`. */
export function getTypstZoom(): number {
  return typstZoom;
}

export function setTypstZoom(v: number): void {
  if (!isFinite(v)) return;
  const clamped = Math.max(MIN_TYPST_ZOOM, Math.min(MAX_TYPST_ZOOM, v));
  if (typstZoom === clamped) return;
  typstZoom = clamped;
  void setValue("typstZoom", clamped);
  for (const l of listeners) l();
}

/** Bump the Typst zoom by `direction * step`, clamped to the allowed range. */
export function adjustTypstZoom(direction: 1 | -1): void {
  setTypstZoom(typstZoom + direction * TYPST_ZOOM_STEP);
}

export function resetTypstZoom(): void {
  setTypstZoom(DEFAULT_TYPST_ZOOM);
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Load persisted settings into the in-memory cache. Call once at startup. */
export async function loadSettings(): Promise<void> {
  try {
    const stored = await getValue<RemoteImagePolicy>("remoteImagePolicy");
    if (stored === "load" || stored === "placeholder" || stored === "off") {
      remoteImagePolicy = stored;
    }
    const storedAutoSave = await getValue<boolean>("autoSave");
    if (typeof storedAutoSave === "boolean") {
      autoSave = storedAutoSave;
    }
    const storedFolderOpen = await getValue<boolean>("folderSectionOpen");
    if (typeof storedFolderOpen === "boolean") {
      folderSectionOpen = storedFolderOpen;
    }
    const storedTocOpen = await getValue<boolean>("tocSectionOpen");
    if (typeof storedTocOpen === "boolean") {
      tocSectionOpen = storedTocOpen;
    }
    const storedPane = await getValue<Partial<Record<Format, boolean>>>("previewPaneOpen");
    if (storedPane && typeof storedPane === "object") {
      previewPaneOpen = {
        markdown: typeof storedPane.markdown === "boolean" ? storedPane.markdown : DEFAULT_PREVIEW_PANE.markdown,
        typst:    typeof storedPane.typst    === "boolean" ? storedPane.typst    : DEFAULT_PREVIEW_PANE.typst,
      };
    }
    const storedWidth = await getValue<number>("previewPaneWidth");
    if (typeof storedWidth === "number" && isFinite(storedWidth)) {
      previewPaneWidth = Math.max(MIN_PREVIEW_PANE_WIDTH, Math.min(MAX_PREVIEW_PANE_WIDTH, storedWidth));
    }
    const storedZoom = await getValue<number>("typstZoom");
    if (typeof storedZoom === "number" && isFinite(storedZoom)) {
      typstZoom = Math.max(MIN_TYPST_ZOOM, Math.min(MAX_TYPST_ZOOM, storedZoom));
    }
  } catch {
    // No store available (e.g. Node test env). Stick with defaults.
  }
}

/** Remote in the network sense: http(s) or protocol-relative. data:/blob:/file:
 * URIs and relative paths don't trigger a network fetch and aren't policy-gated. */
export function isRemoteUrl(url: string): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url) || /^\/\//.test(url);
}

export function shouldRenderImage(url: string, policy: RemoteImagePolicy): boolean {
  if (!isRemoteUrl(url)) return true;
  return policy === "load";
}
