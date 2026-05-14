import { getValue, setValue } from "./store";

export type RemoteImagePolicy = "load" | "placeholder" | "off";

const DEFAULT_REMOTE_IMAGE_POLICY: RemoteImagePolicy = "placeholder";
const DEFAULT_AUTO_SAVE: boolean = false;
const DEFAULT_FOLDER_SECTION_OPEN: boolean = true;
const DEFAULT_TOC_SECTION_OPEN: boolean = true;
// Spell-check defaults OFF per REQUIREMENTS §7 / issue #63: most documents are
// prose-plus-code mixed with identifiers/URLs/foreign words, and the native
// red-underline noise is unwelcome by default. Users can opt-in from prefs.
const DEFAULT_SPELLCHECK: boolean = false;

let remoteImagePolicy: RemoteImagePolicy = DEFAULT_REMOTE_IMAGE_POLICY;
let autoSave: boolean = DEFAULT_AUTO_SAVE;
let folderSectionOpen: boolean = DEFAULT_FOLDER_SECTION_OPEN;
let tocSectionOpen: boolean = DEFAULT_TOC_SECTION_OPEN;
let spellcheck: boolean = DEFAULT_SPELLCHECK;
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

export function getSpellcheck(): boolean {
  return spellcheck;
}

export function setSpellcheck(v: boolean): void {
  if (spellcheck === v) return;
  spellcheck = v;
  void setValue("spellcheck", v);
  for (const l of listeners) l();
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
    const storedSpellcheck = await getValue<boolean>("spellcheck");
    if (typeof storedSpellcheck === "boolean") {
      spellcheck = storedSpellcheck;
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
